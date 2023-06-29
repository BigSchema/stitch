import type {
  DocumentNode,
  ExecutionResult,
  FieldNode,
  SelectionNode,
} from 'graphql';
import { GraphQLError } from 'graphql';
import type { ObjMap } from '../types/ObjMap.js';
import type { PromiseOrValue } from '../types/PromiseOrValue.js';
import { AccumulatorMap } from '../utilities/AccumulatorMap.js';
import { PromiseAggregator } from '../utilities/PromiseAggregator.js';
import type { StitchPlan } from './Planner.js';
import type { Subschema, SuperSchema } from './SuperSchema.js';
type Path = ReadonlyArray<string | number>;
export interface Stitch {
  fromSubschema: Subschema;
  stitchPlans: ObjMap<StitchPlan> | undefined;
  initialResult: PromiseOrValue<ExecutionResult>;
}
interface FetchPlan {
  fieldNodes: ReadonlyArray<FieldNode>;
  stitchPlans: ObjMap<StitchPlan> | undefined;
  parent: ObjMap<unknown>;
  target: ObjMap<unknown>;
  path: Path;
}
/**
 * @internal
 */
export declare class Composer {
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
  );
  compose(): PromiseOrValue<ExecutionResult>;
  _createDocument(selections: ReadonlyArray<SelectionNode>): DocumentNode;
  _buildResponse(): ExecutionResult;
  _handleMaybeAsyncResult(
    parent: ObjMap<unknown> | undefined,
    fields: ObjMap<unknown>,
    stitch: Stitch,
    path: Path,
  ): void;
  _handleResult(
    parent: ObjMap<unknown> | undefined,
    fields: ObjMap<unknown>,
    stitch: Stitch | undefined,
    result: ExecutionResult,
    path: Path,
  ): void;
  _walkStitchPlans(
    subFetchMap: AccumulatorMap<Subschema, FetchPlan>,
    fields: ObjMap<unknown>,
    stitchPlans: ObjMap<StitchPlan>,
    path: Path,
  ): void;
  _collectSubFetches(
    subFetchMap: AccumulatorMap<Subschema, FetchPlan>,
    parent: ObjMap<unknown> | Array<unknown>,
    fieldsOrList: ObjMap<unknown> | Array<unknown>,
    stitchPlan: StitchPlan,
    path: Path,
  ): void;
}
export {};
