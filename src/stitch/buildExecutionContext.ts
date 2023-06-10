import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from 'graphql';
import { assertValidSchema, GraphQLError, Kind } from 'graphql';

import type { ObjMap } from '../types/ObjMap.js';

import { applySkipIncludeDirectives } from '../utilities/applySkipIncludeDirectives.js';

import type { ExecutionContext, Subschema } from './SuperSchema.js';
import { SuperSchema } from './SuperSchema.js';

export interface ExecutionArgs {
  subschemas: ReadonlyArray<Subschema>;
  document: DocumentNode;
  variableValues?: { readonly [variable: string]: unknown } | undefined;
  operationName?: string | undefined;
}

export function buildExecutionContext(
  args: ExecutionArgs,
): ReadonlyArray<GraphQLError> | ExecutionContext {
  const {
    subschemas,
    document,
    variableValues: rawVariableValues,
    operationName,
  } = args;

  for (const subschema of subschemas) {
    // If the schema used for execution is invalid, throw an error.
    assertValidSchema(subschema.schema);
  }

  const superSchema = new SuperSchema(subschemas);

  let operation: OperationDefinitionNode | undefined;
  let fragments: Array<FragmentDefinitionNode> = [];
  for (const definition of document.definitions) {
    switch (definition.kind) {
      case Kind.OPERATION_DEFINITION:
        if (operationName == null) {
          if (operation !== undefined) {
            return [
              new GraphQLError(
                'Must provide operation name if query contains multiple operations.',
              ),
            ];
          }
          operation = definition;
        } else if (definition.name?.value === operationName) {
          operation = definition;
        }
        break;
      case Kind.FRAGMENT_DEFINITION:
        fragments.push(definition);
        break;
      default:
      // ignore non-executable definitions
    }
  }

  if (!operation) {
    if (operationName != null) {
      return [new GraphQLError(`Unknown operation named "${operationName}".`)];
    }
    return [new GraphQLError('Must provide an operation.')];
  }

  // FIXME: https://github.com/graphql/graphql-js/issues/2203
  /* c8 ignore next */
  const variableDefinitions = operation.variableDefinitions ?? [];

  const coercedVariableValues = superSchema.getVariableValues(
    variableDefinitions,
    rawVariableValues ?? {},
    { maxErrors: 50 },
  );

  if (coercedVariableValues.errors) {
    return coercedVariableValues.errors;
  }

  const coerced = coercedVariableValues.coerced;

  operation = applySkipIncludeDirectives(operation, coerced);

  const fragmentMap: ObjMap<FragmentDefinitionNode> = Object.create(null);
  fragments = fragments.map((fragment) => {
    const processedFragment = applySkipIncludeDirectives(fragment, coerced);
    fragmentMap[fragment.name.value] = processedFragment;
    return processedFragment;
  });

  return {
    operationContext: {
      superSchema,
      operation,
      fragments,
      fragmentMap,
      variableDefinitions,
    },
    rawVariableValues,
    coercedVariableValues: coerced,
  };
}
