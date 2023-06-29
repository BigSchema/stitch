import type {
  DocumentNode,
  ExecutionResult,
  FieldNode,
  SelectionNode,
} from 'graphql';
import { GraphQLError, isObjectType, Kind, OperationTypeNode } from 'graphql';
import type { ObjMap } from '../types/ObjMap.ts';
import type { PromiseOrValue } from '../types/PromiseOrValue.ts';
import { isPromise } from '../predicates/isPromise.ts';
import { AccumulatorMap } from '../utilities/AccumulatorMap.ts';
import { inspect } from '../utilities/inspect.ts';
import { invariant } from '../utilities/invariant.ts';
import { PromiseAggregator } from '../utilities/PromiseAggregator.ts';
import type { StitchTree } from './Planner.ts';
import type { Subschema, SuperSchema } from './SuperSchema.ts';
type Path = ReadonlyArray<string | number>;
export interface Stitch {
  fromSubschema: Subschema;
  stitchTrees: ObjMap<StitchTree> | undefined;
  initialResult: PromiseOrValue<ExecutionResult>;
}
interface FetchPlan {
  fieldNodes: ReadonlyArray<FieldNode>;
  stitchTrees: ObjMap<StitchTree> | undefined;
  parent: ObjMap<unknown>;
  target: ObjMap<unknown>;
  path: Path;
}
/**
 * @internal
 */
export class Composer {
  stitches: Array<Stitch>;
  superSchema: SuperSchema;
  rawVariableValues:
    | {
        readonly [variable: string]: unknown;
      }
    | undefined;
  fields: ObjMap<unknown>;
  errors: Array<GraphQLError>;
  nulled: boolean;
  promiseAggregator: PromiseAggregator;
  constructor(
    stitches: Array<Stitch>,
    superSchema: SuperSchema,
    rawVariableValues:
      | {
          readonly [variable: string]: unknown;
        }
      | undefined,
  ) {
    this.stitches = stitches;
    this.superSchema = superSchema;
    this.rawVariableValues = rawVariableValues;
    this.fields = Object.create(null);
    this.errors = [];
    this.nulled = false;
    this.promiseAggregator = new PromiseAggregator();
  }
  compose(): PromiseOrValue<ExecutionResult> {
    for (const stitch of this.stitches) {
      this._handleMaybeAsyncResult(undefined, this.fields, stitch, []);
    }
    if (this.promiseAggregator.isEmpty()) {
      return this._buildResponse();
    }
    return this.promiseAggregator.resolved().then(() => this._buildResponse());
  }
  _createDocument(selections: ReadonlyArray<SelectionNode>): DocumentNode {
    return {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          kind: Kind.OPERATION_DEFINITION,
          operation: OperationTypeNode.QUERY,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections,
          },
        },
      ],
    };
  }
  _buildResponse(): ExecutionResult {
    const fieldsOrNull = this.nulled ? null : this.fields;
    return this.errors.length > 0
      ? { data: fieldsOrNull, errors: this.errors }
      : { data: fieldsOrNull };
  }
  _handleMaybeAsyncResult(
    parent: ObjMap<unknown> | undefined,
    fields: ObjMap<unknown>,
    stitch: Stitch,
    path: Path,
  ): void {
    const initialResult = stitch.initialResult;
    if (!isPromise(initialResult)) {
      this._handleResult(parent, fields, stitch, initialResult, path);
      return;
    }
    const promise = initialResult.then(
      (resolved) => this._handleResult(parent, fields, stitch, resolved, path),
      (err) =>
        this._handleResult(
          parent,
          fields,
          stitch,
          {
            data: null,
            errors: [new GraphQLError(err.message, { originalError: err })],
          },
          path,
        ),
    );
    this.promiseAggregator.add(promise);
  }
  _handleResult(
    parent: ObjMap<unknown> | undefined,
    fields: ObjMap<unknown>,
    stitch: Stitch | undefined,
    result: ExecutionResult,
    path: Path,
  ): void {
    if (result.errors != null) {
      this.errors.push(...result.errors);
    }
    const parentKey: string | number | undefined = path[path.length - 1];
    if (parent !== undefined) {
      if (parent[parentKey] === null) {
        return;
      }
    } else if (this.nulled) {
      return;
    }
    if (result.data == null) {
      if (parentKey === undefined) {
        this.nulled = true;
      } else if (parent) {
        parent[parentKey] = null;
        // TODO: null bubbling?
      }
      return;
    }
    for (const [key, value] of Object.entries(result.data)) {
      fields[key] = value;
    }
    if (stitch?.stitchTrees !== undefined) {
      const subFetchMap = new AccumulatorMap<Subschema, FetchPlan>();
      this._walkStitchTrees(subFetchMap, result.data, stitch.stitchTrees, path);
      for (const [subschema, subFetches] of subFetchMap) {
        for (const subFetch of subFetches) {
          // TODO: batch subStitches by accessors
          // TODO: batch subStitches by subschema?
          const subStitch: Stitch = {
            fromSubschema: subschema,
            stitchTrees: subFetch.stitchTrees,
            initialResult: subschema.executor({
              document: this._createDocument(subFetch.fieldNodes),
              variables: this.rawVariableValues,
            }),
          };
          this._handleMaybeAsyncResult(
            subFetch.parent,
            subFetch.target,
            subStitch,
            subFetch.path,
          );
        }
      }
    }
  }
  _walkStitchTrees(
    subFetchMap: AccumulatorMap<Subschema, FetchPlan>,
    fields: ObjMap<unknown>,
    stitchTrees: ObjMap<StitchTree>,
    path: Path,
  ): void {
    for (const [key, stitchTree] of Object.entries(stitchTrees)) {
      if (fields[key] !== undefined) {
        this._collectSubFetches(
          subFetchMap,
          fields,
          fields[key] as ObjMap<unknown> | Array<unknown>,
          stitchTree,
          [...path, key],
        );
      }
    }
  }
  _collectSubFetches(
    subFetchMap: AccumulatorMap<Subschema, FetchPlan>,
    parent: ObjMap<unknown> | Array<unknown>,
    fieldsOrList: ObjMap<unknown> | Array<unknown>,
    stitchTree: StitchTree,
    path: Path,
  ): void {
    if (Array.isArray(fieldsOrList)) {
      for (let i = 0; i < fieldsOrList.length; i++) {
        this._collectSubFetches(
          subFetchMap,
          fieldsOrList,
          fieldsOrList[i] as ObjMap<unknown>,
          stitchTree,
          [...path, i],
        );
      }
      return;
    }
    const typeName = fieldsOrList.__stitching__typename as
      | string
      | undefined
      | null;
    typeName != null ||
      invariant(
        false,
        `Missing entry '__stitching__typename' in response ${inspect(
          fieldsOrList,
        )}.`,
      );
    const type = this.superSchema.getType(typeName);
    isObjectType(type) ||
      invariant(false, `Expected Object type, received '${typeName}'.`);
    const fieldPlan = stitchTree.fieldPlans.get(type);
    fieldPlan !== undefined ||
      invariant(false, `Missing field plan for type '${typeName}'.`);
    for (const [subschema, subschemaPlan] of fieldPlan.subschemaPlans) {
      subFetchMap.add(subschema, {
        fieldNodes: subschemaPlan.fieldNodes,
        stitchTrees: subschemaPlan.stitchTrees,
        parent: parent as ObjMap<unknown>,
        target: fieldsOrList,
        path,
      });
    }
    this._walkStitchTrees(
      subFetchMap,
      fieldsOrList,
      fieldPlan.stitchTrees,
      path,
    );
  }
}
