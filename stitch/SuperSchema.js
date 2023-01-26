'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
exports.SuperSchema = void 0;
const graphql_1 = require('graphql');
const hasOwnProperty_js_1 = require('../utilities/hasOwnProperty.js');
const inlineRootFragments_js_1 = require('../utilities/inlineRootFragments.js');
const inspect_js_1 = require('../utilities/inspect.js');
const invariant_js_1 = require('../utilities/invariant.js');
const printPathArray_js_1 = require('../utilities/printPathArray.js');
const operations = [
  graphql_1.OperationTypeNode.QUERY,
  graphql_1.OperationTypeNode.MUTATION,
  graphql_1.OperationTypeNode.SUBSCRIPTION,
];
/**
 * @internal
 */
class SuperSchema {
  constructor(schemas) {
    this.subschemas = schemas;
    this.subschemaSetsByTypeAndField = Object.create(null);
    this.mergedRootTypes = Object.create(null);
    this.mergedTypes = Object.create(null);
    this.mergedDirectives = Object.create(null);
    this._createMergedElements();
    this.mergedSchema = new graphql_1.GraphQLSchema({
      query: this.mergedRootTypes[graphql_1.OperationTypeNode.QUERY],
      mutation: this.mergedRootTypes[graphql_1.OperationTypeNode.MUTATION],
      subscription:
        this.mergedRootTypes[graphql_1.OperationTypeNode.SUBSCRIPTION],
      types: Object.values(this.mergedTypes),
      directives: Object.values(this.mergedDirectives),
    });
    const queryType = this.mergedSchema.getQueryType();
    if (queryType) {
      const introspectionSubschema = {
        schema: this.mergedSchema,
        executor: (args) =>
          (0, graphql_1.execute)({
            ...args,
            schema: this.mergedSchema,
          }),
      };
      for (const [name, type] of Object.entries(
        this.mergedSchema.getTypeMap(),
      )) {
        if (!name.startsWith('__')) {
          continue;
        }
        if ((0, graphql_1.isCompositeType)(type)) {
          this._addToSubschemaSets(introspectionSubschema, name, type);
        }
      }
      const subSchemaSetsByField =
        this.subschemaSetsByTypeAndField[queryType.name];
      subSchemaSetsByField.__schema = new Set([introspectionSubschema]);
      subSchemaSetsByField.__type = new Set([introspectionSubschema]);
    }
  }
  _createMergedElements() {
    const originalRootTypes = Object.create(null);
    const originalTypes = Object.create(null);
    const originalDirectives = Object.create(null);
    for (const subschema of this.subschemas) {
      const schema = subschema.schema;
      for (const operation of operations) {
        const rootType = schema.getRootType(operation);
        if (rootType) {
          if (!originalRootTypes[operation]) {
            originalRootTypes[operation] = [rootType];
          } else {
            originalRootTypes[operation].push(rootType);
          }
        }
      }
      for (const [name, type] of Object.entries(schema.getTypeMap())) {
        if (name.startsWith('__')) {
          continue;
        }
        if (!originalTypes[name]) {
          originalTypes[name] = [type];
        } else {
          originalTypes[name].push(type);
        }
        if ((0, graphql_1.isCompositeType)(type)) {
          this._addToSubschemaSets(subschema, name, type);
        }
      }
      for (const directive of schema.getDirectives()) {
        const name = directive.name;
        if (!originalDirectives[name]) {
          originalDirectives[name] = [directive];
        } else {
          originalDirectives[name].push(directive);
        }
      }
    }
    for (const [operation, rootTypes] of Object.entries(originalRootTypes)) {
      this.mergedRootTypes[operation] = this._mergeObjectTypes(rootTypes);
    }
    const mergedRootTypes = Object.values(this.mergedRootTypes);
    for (const [typeName, types] of Object.entries(originalTypes)) {
      const firstType = types[0];
      if (firstType instanceof graphql_1.GraphQLScalarType) {
        if ((0, graphql_1.isSpecifiedScalarType)(firstType)) {
          this.mergedTypes[typeName] = firstType;
          continue;
        }
        this.mergedTypes[typeName] = this._mergeScalarTypes(types);
      } else if (firstType instanceof graphql_1.GraphQLObjectType) {
        const rootType = mergedRootTypes.find((type) => type.name === typeName);
        if (rootType) {
          this.mergedTypes[typeName] = rootType;
          continue;
        }
        this.mergedTypes[typeName] = this._mergeObjectTypes(types);
      } else if (firstType instanceof graphql_1.GraphQLInterfaceType) {
        this.mergedTypes[typeName] = this._mergeInterfaceTypes(types);
      } else if (firstType instanceof graphql_1.GraphQLUnionType) {
        this.mergedTypes[typeName] = this._mergeUnionTypes(types);
      } else if (firstType instanceof graphql_1.GraphQLInputObjectType) {
        this.mergedTypes[typeName] = this._mergeInputObjectTypes(types);
      } else if (firstType instanceof graphql_1.GraphQLEnumType) {
        this.mergedTypes[typeName] = this._mergeEnumTypes(types);
      }
    }
    for (const [directiveName, directives] of Object.entries(
      originalDirectives,
    )) {
      this.mergedDirectives[directiveName] = this._mergeDirectives(directives);
    }
  }
  _addToSubschemaSets(subschema, name, type) {
    let subschemaSetsByField = this.subschemaSetsByTypeAndField[name];
    if (!subschemaSetsByField) {
      subschemaSetsByField = Object.create(null);
      this.subschemaSetsByTypeAndField[name] = subschemaSetsByField;
    }
    let typenameSubschemaSet = subschemaSetsByField.__typename;
    if (!typenameSubschemaSet) {
      typenameSubschemaSet = new Set();
      subschemaSetsByField.__typename = typenameSubschemaSet;
    }
    typenameSubschemaSet.add(subschema);
    if ((0, graphql_1.isUnionType)(type)) {
      return;
    }
    for (const fieldName of Object.keys(type.getFields())) {
      let subschemaSet = subschemaSetsByField[fieldName];
      if (!subschemaSet) {
        subschemaSet = new Set();
        subschemaSetsByField[fieldName] = subschemaSet;
      }
      subschemaSet.add(subschema);
    }
  }
  _mergeScalarTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLScalarType({
      name: firstType.name,
      description: firstType.description,
    });
  }
  _mergeObjectTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLObjectType({
      name: firstType.name,
      description: firstType.description,
      fields: () => this._getMergedFieldMap(originalTypes),
      interfaces: () => this._getMergedInterfaces(originalTypes),
    });
  }
  _mergeInterfaceTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLInterfaceType({
      name: firstType.name,
      description: firstType.description,
      fields: () => this._getMergedFieldMap(originalTypes),
      interfaces: () => this._getMergedInterfaces(originalTypes),
    });
  }
  _mergeUnionTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLUnionType({
      name: firstType.name,
      description: firstType.description,
      types: () => this._getMergedMemberTypes(originalTypes),
    });
  }
  _mergeInputObjectTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLInputObjectType({
      name: firstType.name,
      description: firstType.description,
      fields: () => this._getMergedInputFieldMap(originalTypes),
    });
  }
  _mergeEnumTypes(originalTypes) {
    const firstType = originalTypes[0];
    return new graphql_1.GraphQLEnumType({
      name: firstType.name,
      description: firstType.description,
      values: this._mergeEnumValueMaps(originalTypes),
    });
  }
  _mergeDirectives(originalDirectives) {
    const firstDirective = originalDirectives[0];
    const args = Object.create(null);
    const mergedDirective = new graphql_1.GraphQLDirective({
      name: firstDirective.name,
      description: firstDirective.description,
      locations: this._mergeDirectiveLocations(originalDirectives),
      args,
      isRepeatable: originalDirectives.some(
        (directive) => directive.isRepeatable,
      ),
    });
    for (const arg of mergedDirective.args) {
      args[arg.name] = this._argToArgConfig(arg);
    }
    return mergedDirective;
  }
  _getMergedFieldMap(originalTypes) {
    const fields = Object.create(null);
    for (const type of originalTypes) {
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        if (fields[fieldName]) {
          continue;
        }
        fields[fieldName] = this._fieldToFieldConfig(field);
      }
    }
    return fields;
  }
  _fieldToFieldConfig(field) {
    const args = Object.create(null);
    const fieldConfig = {
      description: field.description,
      type: this._getMergedType(field.type),
      args,
      deprecationReason: field.deprecationReason,
    };
    for (const arg of field.args) {
      args[arg.name] = this._argToArgConfig(arg);
    }
    return fieldConfig;
  }
  _argToArgConfig(arg) {
    return {
      description: arg.description,
      type: this._getMergedType(arg.type),
      defaultValue: arg.defaultValue,
      deprecationReason: arg.deprecationReason,
    };
  }
  _getMergedInterfaces(originalTypes) {
    const interfaceMap = Object.create(null);
    for (const type of originalTypes) {
      for (const interfaceType of type.getInterfaces()) {
        if (interfaceMap[interfaceType.name]) {
          continue;
        }
        interfaceMap[interfaceType.name] = this._getMergedType(interfaceType);
      }
    }
    return Object.values(interfaceMap);
  }
  _getMergedMemberTypes(originalTypes) {
    const memberMap = Object.create(null);
    for (const unionType of originalTypes) {
      for (const memberType of unionType.getTypes()) {
        if (memberMap[memberType.name]) {
          continue;
        }
        memberMap[memberType.name] = this._getMergedType(memberType);
      }
    }
    return Object.values(memberMap);
  }
  _getMergedInputFieldMap(originalTypes) {
    const fields = Object.create(null);
    for (const type of originalTypes) {
      for (const [fieldName, field] of Object.entries(type.getFields())) {
        if (fields[fieldName]) {
          continue;
        }
        fields[fieldName] = this._inputFieldToInputFieldConfig(field);
      }
    }
    return fields;
  }
  _inputFieldToInputFieldConfig(inputField) {
    return {
      description: inputField.description,
      type: this._getMergedType(inputField.type),
      deprecationReason: inputField.deprecationReason,
    };
  }
  _mergeEnumValueMaps(originalTypes) {
    const values = Object.create(null);
    for (const type of originalTypes) {
      for (const value of type.getValues()) {
        const valueName = value.name;
        if (values[valueName]) {
          continue;
        }
        values[valueName] = this._enumValueToEnumValueConfig(value);
      }
    }
    return values;
  }
  _enumValueToEnumValueConfig(value) {
    return {
      description: value.description,
      value: value.value,
      deprecationReason: value.deprecationReason,
    };
  }
  _mergeDirectiveLocations(originalDirectives) {
    const locations = new Set();
    for (const directive of originalDirectives) {
      for (const location of directive.locations) {
        if (!locations.has(location)) {
          locations.add(location);
        }
      }
    }
    return Array.from(locations.values());
  }
  _getMergedType(type) {
    if ((0, graphql_1.isListType)(type)) {
      return new graphql_1.GraphQLList(this._getMergedType(type.ofType));
    }
    if ((0, graphql_1.isNonNullType)(type)) {
      return new graphql_1.GraphQLNonNull(this._getMergedType(type.ofType));
    }
    return this.mergedTypes[type.name];
  }
  getRootType(operation) {
    return this.mergedRootTypes[operation];
  }
  getType(name) {
    return this.mergedTypes[name];
  }
  /**
   * Prepares an object map of variableValues of the correct type based on the
   * provided variable definitions and arbitrary input. If the input cannot be
   * parsed to match the variable definitions, a GraphQLError will be thrown.
   *
   * Note: The returned value is a plain Object with a prototype, since it is
   * exposed to user code. Care should be taken to not pull values from the
   * Object prototype.
   */
  getVariableValues(varDefNodes, inputs, options) {
    const errors = [];
    const maxErrors = options?.maxErrors;
    try {
      const coerced = this._coerceVariableValues(
        varDefNodes,
        inputs,
        (error) => {
          if (maxErrors != null && errors.length >= maxErrors) {
            throw new graphql_1.GraphQLError(
              'Too many errors processing variables, error limit reached. Execution aborted.',
            );
          }
          errors.push(error);
        },
      );
      if (errors.length === 0) {
        return { coerced };
      }
    } catch (error) {
      errors.push(error);
    }
    return { errors };
  }
  _typeFromAST(typeNode) {
    switch (typeNode.kind) {
      case graphql_1.Kind.LIST_TYPE: {
        const innerType = this._typeFromAST(typeNode.type);
        return innerType && new graphql_1.GraphQLList(innerType);
      }
      case graphql_1.Kind.NON_NULL_TYPE: {
        const innerType = this._typeFromAST(typeNode.type);
        return innerType && new graphql_1.GraphQLNonNull(innerType);
      }
      case graphql_1.Kind.NAMED_TYPE:
        return this.mergedTypes[typeNode.name.value];
    }
  }
  _coerceVariableValues(varDefNodes, inputs, onError) {
    const coercedValues = {};
    for (const varDefNode of varDefNodes) {
      const varName = varDefNode.variable.name.value;
      const varType = this._typeFromAST(varDefNode.type);
      if (!(0, graphql_1.isInputType)(varType)) {
        // Must use input types for variables. This should be caught during
        // validation, however is checked again here for safety.
        const varTypeStr = (0, graphql_1.print)(varDefNode.type);
        onError(
          new graphql_1.GraphQLError(
            `Variable "$${varName}" expected value of type "${varTypeStr}" which cannot be used as an input type.`,
            { nodes: varDefNode.type },
          ),
        );
        continue;
      }
      if (!(0, hasOwnProperty_js_1.hasOwnProperty)(inputs, varName)) {
        if (varDefNode.defaultValue) {
          coercedValues[varName] = (0, graphql_1.valueFromAST)(
            varDefNode.defaultValue,
            varType,
          );
        } else if ((0, graphql_1.isNonNullType)(varType)) {
          const varTypeStr = (0, inspect_js_1.inspect)(varType);
          onError(
            new graphql_1.GraphQLError(
              `Variable "$${varName}" of required type "${varTypeStr}" was not provided.`,
              { nodes: varDefNode },
            ),
          );
        }
        continue;
      }
      const value = inputs[varName];
      if (value === null && (0, graphql_1.isNonNullType)(varType)) {
        const varTypeStr = (0, inspect_js_1.inspect)(varType);
        onError(
          new graphql_1.GraphQLError(
            `Variable "$${varName}" of non-null type "${varTypeStr}" must not be null.`,
            { nodes: varDefNode },
          ),
        );
        continue;
      }
      coercedValues[varName] = (0, graphql_1.coerceInputValue)(
        value,
        varType,
        (path, invalidValue, error) => {
          let prefix =
            `Variable "$${varName}" got invalid value ` +
            (0, inspect_js_1.inspect)(invalidValue);
          if (path.length > 0) {
            prefix += ` at "${varName}${(0, printPathArray_js_1.printPathArray)(
              path,
            )}"`;
          }
          onError(
            new graphql_1.GraphQLError(prefix + '; ' + error.message, {
              nodes: varDefNode,
              originalError: error.originalError,
            }),
          );
        },
      );
    }
    return coercedValues;
  }
  generatePlan(operationContext) {
    const { operation, fragments, fragmentMap } = operationContext;
    const rootType = this.getRootType(operation.operation);
    rootType !== undefined ||
      (0, invariant_js_1.invariant)(
        false,
        `Schema is not configured to execute ${operation.operation}`,
      );
    const inlinedSelectionSet = (0,
    inlineRootFragments_js_1.inlineRootFragments)(
      operation.selectionSet,
      fragmentMap,
    );
    const map = new Map();
    const subschemaSetsByField =
      this.subschemaSetsByTypeAndField[rootType.name];
    const splitSelections = this.splitSelectionSet(
      subschemaSetsByField,
      inlinedSelectionSet,
    );
    for (const [schema, selections] of splitSelections) {
      const document = {
        kind: graphql_1.Kind.DOCUMENT,
        definitions: [
          {
            ...operation,
            selectionSet: {
              kind: graphql_1.Kind.SELECTION_SET,
              selections,
            },
          },
          ...fragments,
        ],
      };
      map.set(schema, {
        document: this._pruneDocument(document, schema),
      });
    }
    return map;
  }
  splitSelectionSet(subschemaSetsByField, selectionSet) {
    if (subschemaSetsByField === undefined) {
      return new Map();
    }
    const map = new Map();
    for (const selection of selectionSet.selections) {
      switch (selection.kind) {
        case graphql_1.Kind.FIELD: {
          this._addField(subschemaSetsByField, selection, map);
          break;
        }
        case graphql_1.Kind.INLINE_FRAGMENT: {
          this._addInlineFragment(subschemaSetsByField, selection, map);
          break;
        }
        case graphql_1.Kind.FRAGMENT_SPREAD: {
          // Not reached
          false ||
            (0, invariant_js_1.invariant)(
              false,
              'Fragment spreads should be inlined prior to selections being split!',
            );
        }
      }
    }
    return map;
  }
  _addField(subschemaSetsByField, field, map) {
    const subschemas = subschemaSetsByField[field.name.value];
    if (subschemas) {
      let foundSubschema = false;
      for (const subschema of subschemas) {
        const selections = map.get(subschema);
        if (selections) {
          selections.push(field);
          foundSubschema = true;
          break;
        }
      }
      if (!foundSubschema) {
        map.set(subschemas.values().next().value, [field]);
      }
    }
  }
  _addInlineFragment(subschemaSetsByField, fragment, map) {
    const splitSelections = this.splitSelectionSet(
      subschemaSetsByField,
      fragment.selectionSet,
    );
    for (const [fragmentSubschema, fragmentSelections] of splitSelections) {
      const splitFragment = {
        ...fragment,
        selectionSet: {
          kind: graphql_1.Kind.SELECTION_SET,
          selections: fragmentSelections,
        },
      };
      const selections = map.get(fragmentSubschema);
      if (selections) {
        selections.push(splitFragment);
      } else {
        map.set(fragmentSubschema, [splitFragment]);
      }
    }
  }
  _pruneDocument(document, subschema) {
    const typeInfo = new graphql_1.TypeInfo(subschema.schema);
    return (0, graphql_1.visit)(
      document,
      (0, graphql_1.visitWithTypeInfo)(typeInfo, {
        [graphql_1.Kind.SELECTION_SET]: (node) =>
          this._visitSelectionSet(node, subschema, typeInfo),
      }),
    );
  }
  _visitSelectionSet(node, subschema, typeInfo) {
    const prunedSelections = [];
    const maybeType = typeInfo.getParentType();
    if (!maybeType) {
      return {
        ...node,
        selections: prunedSelections,
      };
    }
    const namedType = (0, graphql_1.getNamedType)(maybeType);
    const typeName = namedType.name;
    const subschemaSetsByField = this.subschemaSetsByTypeAndField[typeName];
    if (subschemaSetsByField === undefined) {
      return {
        ...node,
        selections: prunedSelections,
      };
    }
    for (const selection of node.selections) {
      if (
        selection.kind !== graphql_1.Kind.FIELD ||
        subschemaSetsByField[selection.name.value]?.has(subschema)
      ) {
        prunedSelections.push(selection);
      }
    }
    return {
      ...node,
      selections: prunedSelections,
    };
  }
}
exports.SuperSchema = SuperSchema;
