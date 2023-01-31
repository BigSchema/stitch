import type {
  DocumentNode,
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  FragmentDefinitionNode,
  InitialIncrementalExecutionResult,
  OperationDefinitionNode,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import { GraphQLError, Kind } from 'graphql';
import type { ObjMap } from 'graphql/jsutils/ObjMap.js';

import type { PromiseOrValue } from '../types/PromiseOrValue.js';
import type { SimpleAsyncGenerator } from '../types/SimpleAsyncGenerator.js';

import { isAsyncIterable } from '../predicates/isAsyncIterable.js';
import { isPromise } from '../predicates/isPromise.js';
import { Consolidator } from '../utilities/Consolidator.js';

import { mapAsyncIterable } from './mapAsyncIterable.js';
import type { Plan } from './Plan.js';

interface PromiseContext {
  promiseCount: number;
  promise: Promise<void>;
  trigger: () => void;
}

/**
 * @internal
 */
export class PlanResult {
  plan: Plan;
  operation: OperationDefinitionNode;
  fragments: ReadonlyArray<FragmentDefinitionNode>;
  rawVariableValues:
    | {
        readonly [variable: string]: unknown;
      }
    | undefined;

  _data: ObjMap<unknown>;
  _nullData: boolean;
  _errors: Array<GraphQLError>;
  _consolidator: Consolidator<SubsequentIncrementalExecutionResult> | undefined;

  _promiseContext: PromiseContext | undefined;

  constructor(
    plan: Plan,
    operation: OperationDefinitionNode,
    fragments: ReadonlyArray<FragmentDefinitionNode>,
    rawVariableValues:
      | {
          readonly [variable: string]: unknown;
        }
      | undefined,
  ) {
    this.plan = plan;
    this.operation = operation;
    this.fragments = fragments;
    this.rawVariableValues = rawVariableValues;
    this._data = Object.create(null);
    this._nullData = false;
    this._errors = [];
  }

  execute(): PromiseOrValue<
    ExecutionResult | ExperimentalIncrementalExecutionResults
  > {
    for (const [subschema, subschemaSelections] of this.plan.map.entries()) {
      const document: DocumentNode = {
        kind: Kind.DOCUMENT,
        definitions: [
          {
            ...this.operation,
            selectionSet: {
              kind: Kind.SELECTION_SET,
              selections: subschemaSelections,
            },
          },
          ...this.fragments,
        ],
      };

      const result = subschema.executor({
        document,
        variables: this.rawVariableValues,
      });

      if (isPromise(result)) {
        if (this._promiseContext) {
          this._promiseContext.promiseCount++;
        } else {
          let trigger: (() => void) | undefined;
          const promiseContext: PromiseContext = {
            promiseCount: 1,
            promise: new Promise((resolve) => {
              trigger = resolve;
            }),
          } as PromiseContext;
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          promiseContext.trigger = trigger!;
          this._promiseContext = promiseContext;
        }

        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        result.then((resolved) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          const promiseContext = this._promiseContext!;
          promiseContext.promiseCount--;
          this._handlePossibleMultiPartResult(resolved);
          if (promiseContext.promiseCount === 0) {
            promiseContext.trigger();
          }
        });
      } else {
        this._handlePossibleMultiPartResult(result);
      }
    }

    return this._promiseContext !== undefined
      ? this._promiseContext.promise.then(() => this._return())
      : this._return();
  }

  subscribe(): PromiseOrValue<
    ExecutionResult | SimpleAsyncGenerator<ExecutionResult>
  > {
    const iteration = this.plan.map.entries().next();
    if (iteration.done) {
      const error = new GraphQLError('Could not route subscription.', {
        nodes: this.operation,
      });

      return { errors: [error] };
    }

    const [subschema, subschemaSelections] = iteration.value;

    const subscriber = subschema.subscriber;
    if (!subscriber) {
      const error = new GraphQLError(
        'Subschema is not configured to execute subscription operation.',
        { nodes: this.operation },
      );

      return { errors: [error] };
    }

    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [
        {
          ...this.operation,
          selectionSet: {
            kind: Kind.SELECTION_SET,
            selections: subschemaSelections,
          },
        },
        ...this.fragments,
      ],
    };

    const result = subscriber({
      document,
      variables: this.rawVariableValues,
    });

    if (isPromise(result)) {
      return result.then((resolved) => this._handlePossibleStream(resolved));
    }
    return this._handlePossibleStream(result);
  }

  _return(): PromiseOrValue<
    ExecutionResult | ExperimentalIncrementalExecutionResults
  > {
    const dataOrNull = this._nullData ? null : this._data;

    if (this._consolidator !== undefined) {
      this._consolidator.close();

      const initialResult =
        this._errors.length > 0
          ? { data: dataOrNull, errors: this._errors, hasNext: true }
          : { data: dataOrNull, hasNext: true };

      return {
        initialResult,
        subsequentResults: this._consolidator,
      };
    }

    return this._errors.length > 0
      ? { data: dataOrNull, errors: this._errors }
      : { data: dataOrNull };
  }

  _handlePossibleMultiPartResult<
    T extends ExecutionResult | ExperimentalIncrementalExecutionResults,
  >(result: T): void {
    if ('initialResult' in result) {
      this._handleSingleResult(result.initialResult);

      if (this._consolidator === undefined) {
        this._consolidator = new Consolidator<SubsequentIncrementalExecutionResult>([
          result.subsequentResults,
        ]);
      } else {
        this._consolidator.add(result.subsequentResults);
      }
    } else {
      this._handleSingleResult(result);
    }
  }

  _handleSingleResult(
    result: ExecutionResult | InitialIncrementalExecutionResult,
  ): void {
    if (result.errors != null) {
      this._errors.push(...result.errors);
    }
    if (this._nullData) {
      return;
    }
    if (result.data == null) {
      this._nullData = true;
      return;
    }

    Object.assign(this._data, result.data);
  }

  _handlePossibleStream<
    T extends ExecutionResult | SimpleAsyncGenerator<ExecutionResult>,
  >(result: T): PromiseOrValue<T> {
    if (isAsyncIterable(result)) {
      return mapAsyncIterable(result, (payload) => payload) as T;
    }

    return result;
  }
}
