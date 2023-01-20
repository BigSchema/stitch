import { assert } from 'chai';
import type {
  ExecutionArgs,
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
} from 'graphql';
import { experimentalExecuteIncrementally as graphqlExecute } from 'graphql';

import type { PromiseOrValue } from '../../../types/PromiseOrValue.js';

import { isAsyncIterable } from '../../../utilities/isAsyncIterable.js';
import { isPromise } from '../../../utilities/isPromise.js';

import { stitch } from '../../stitch.js';

export function executeWithGraphQL(
  args: ExecutionArgs,
): PromiseOrValue<
  | ExecutionResult
  | AsyncIterableIterator<ExecutionResult>
  | ExperimentalIncrementalExecutionResults
> {
  return stitch({
    ...args,
    operationName: args.operationName ?? undefined,
    variableValues: args.variableValues ?? undefined,
    executor: ({ document, variables }) =>
      graphqlExecute({
        ...args,
        document,
        variableValues: variables,
      }),
  });
}

export function executeSyncWithGraphQL(args: ExecutionArgs): ExecutionResult {
  const result = executeWithGraphQL(args);

  assert(
    !isPromise(result) &&
      !isAsyncIterable(result) &&
      !('initialResult' in result),
  );

  return result;
}