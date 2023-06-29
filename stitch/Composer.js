'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.Composer = void 0;
const graphql_1 = require('graphql');
const isPromise_js_1 = require('../predicates/isPromise.js');
const AccumulatorMap_js_1 = require('../utilities/AccumulatorMap.js');
const inspect_js_1 = require('../utilities/inspect.js');
const invariant_js_1 = require('../utilities/invariant.js');
const PromiseAggregator_js_1 = require('../utilities/PromiseAggregator.js');
/**
 * @internal
 */
class Composer {
  constructor(stitches, superSchema, rawVariableValues) {
    this.stitches = stitches;
    this.superSchema = superSchema;
    this.rawVariableValues = rawVariableValues;
    this.fields = Object.create(null);
    this.errors = [];
    this.nulled = false;
    this.promiseAggregator = new PromiseAggregator_js_1.PromiseAggregator();
  }
  compose() {
    for (const stitch of this.stitches) {
      this._handleMaybeAsyncResult(undefined, this.fields, stitch, []);
    }
    if (this.promiseAggregator.isEmpty()) {
      return this._buildResponse();
    }
    return this.promiseAggregator.resolved().then(() => this._buildResponse());
  }
  _createDocument(selections) {
    return {
      kind: graphql_1.Kind.DOCUMENT,
      definitions: [
        {
          kind: graphql_1.Kind.OPERATION_DEFINITION,
          operation: graphql_1.OperationTypeNode.QUERY,
          selectionSet: {
            kind: graphql_1.Kind.SELECTION_SET,
            selections,
          },
        },
      ],
    };
  }
  _buildResponse() {
    const fieldsOrNull = this.nulled ? null : this.fields;
    return this.errors.length > 0
      ? { data: fieldsOrNull, errors: this.errors }
      : { data: fieldsOrNull };
  }
  _handleMaybeAsyncResult(parent, fields, stitch, path) {
    const initialResult = stitch.initialResult;
    if (!(0, isPromise_js_1.isPromise)(initialResult)) {
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
            errors: [
              new graphql_1.GraphQLError(err.message, { originalError: err }),
            ],
          },
          path,
        ),
    );
    this.promiseAggregator.add(promise);
  }
  _handleResult(parent, fields, stitch, result, path) {
    if (result.errors != null) {
      this.errors.push(...result.errors);
    }
    const parentKey = path[path.length - 1];
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
    if (stitch?.stitchPlans !== undefined) {
      const subFetchMap = new AccumulatorMap_js_1.AccumulatorMap();
      this._walkStitchPlans(subFetchMap, result.data, stitch.stitchPlans, path);
      for (const [subschema, subFetches] of subFetchMap) {
        for (const subFetch of subFetches) {
          // TODO: batch subStitches by accessors
          // TODO: batch subStitches by subschema?
          const subStitch = {
            fromSubschema: subschema,
            stitchPlans: subFetch.stitchPlans,
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
  _walkStitchPlans(subFetchMap, fields, stitchPlans, path) {
    for (const [key, stitchPlan] of Object.entries(stitchPlans)) {
      if (fields[key] !== undefined) {
        this._collectSubFetches(subFetchMap, fields, fields[key], stitchPlan, [
          ...path,
          key,
        ]);
      }
    }
  }
  _collectSubFetches(subFetchMap, parent, fieldsOrList, stitchPlan, path) {
    if (Array.isArray(fieldsOrList)) {
      for (let i = 0; i < fieldsOrList.length; i++) {
        this._collectSubFetches(
          subFetchMap,
          fieldsOrList,
          fieldsOrList[i],
          stitchPlan,
          [...path, i],
        );
      }
      return;
    }
    const typeName = fieldsOrList.__stitching__typename;
    typeName != null ||
      (0, invariant_js_1.invariant)(
        false,
        `Missing entry '__stitching__typename' in response ${(0,
        inspect_js_1.inspect)(fieldsOrList)}.`,
      );
    const type = this.superSchema.getType(typeName);
    (0, graphql_1.isObjectType)(type) ||
      (0, invariant_js_1.invariant)(
        false,
        `Expected Object type, received '${typeName}'.`,
      );
    const fieldPlan = stitchPlan.get(type);
    fieldPlan !== undefined ||
      (0, invariant_js_1.invariant)(
        false,
        `Missing field plan for type '${typeName}'.`,
      );
    for (const [subschema, subschemaPlan] of fieldPlan.subschemaPlans) {
      subFetchMap.add(subschema, {
        fieldNodes: subschemaPlan.fieldNodes,
        stitchPlans: subschemaPlan.stitchPlans,
        parent: parent,
        target: fieldsOrList,
        path,
      });
    }
    this._walkStitchPlans(
      subFetchMap,
      fieldsOrList,
      fieldPlan.stitchPlans,
      path,
    );
  }
}
exports.Composer = Composer;
