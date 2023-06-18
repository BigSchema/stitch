import type {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLObjectType,
  InlineFragmentNode,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import {
  getNamedType,
  isCompositeType,
  isInterfaceType,
  isObjectType,
  Kind,
  print,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from 'graphql';

import type { ObjMap } from '../types/ObjMap.js';

import { AccumulatorMap } from '../utilities/AccumulatorMap.js';
import { inspect } from '../utilities/inspect.js';
import { invariant } from '../utilities/invariant.js';
import { memoize3 } from '../utilities/memoize3.js';

import type { OperationContext, Subschema } from './SuperSchema.js';

export const createFieldPlan = memoize3(
  (
    operationContext: OperationContext,
    parentType: GraphQLCompositeType,
    selections: ReadonlyArray<SelectionNode>,
  ) => new FieldPlan(operationContext, parentType, selections),
);

/**
 * @internal
 */
export class FieldPlan {
  operationContext: OperationContext;
  parentType: GraphQLCompositeType;
  ownSelections: ReadonlyArray<SelectionNode>;
  selectionMap: Map<Subschema, Array<SelectionNode>>;
  subFieldPlans: ObjMap<FieldPlan>;
  visitedFragments: Set<string>;
  subschema: Subschema | undefined;

  constructor(
    operationContext: OperationContext,
    parentType: GraphQLCompositeType,
    selections: ReadonlyArray<SelectionNode>,
    subschema?: Subschema | undefined,
  ) {
    this.operationContext = operationContext;
    this.parentType = parentType;
    this.subFieldPlans = Object.create(null);
    this.visitedFragments = new Set();
    this.subschema = subschema;

    const { ownSelections, selectionMap } = this._processSelections(
      this.parentType,
      selections,
    );
    this.ownSelections = ownSelections;
    this.selectionMap = selectionMap;
  }

  _processSelections(
    parentType: GraphQLCompositeType,
    selections: ReadonlyArray<SelectionNode>,
  ): {
    ownSelections: Array<SelectionNode>;
    selectionMap: AccumulatorMap<Subschema, SelectionNode>;
  } {
    const ownSelections: Array<SelectionNode> = [];
    const selectionMap = new AccumulatorMap<Subschema, SelectionNode>();
    for (const selection of selections) {
      switch (selection.kind) {
        case Kind.FIELD: {
          this._addField(parentType, selection, ownSelections, selectionMap);
          break;
        }
        case Kind.INLINE_FRAGMENT: {
          const typeName = selection.typeCondition?.name.value;
          const refinedType =
            typeName !== undefined
              ? this.operationContext.superSchema.getType(typeName)
              : parentType;

          invariant(
            isCompositeType(refinedType),
            `Invalid type condition ${inspect(refinedType)}`,
          );

          this._addFragment(
            refinedType,
            selection,
            ownSelections,
            selectionMap,
          );
          break;
        }
        case Kind.FRAGMENT_SPREAD: {
          const fragmentName = selection.name.value;
          if (this.visitedFragments.has(fragmentName)) {
            continue;
          }

          this.visitedFragments.add(fragmentName);

          const fragment = this.operationContext.fragmentMap[fragmentName];

          const typeName = fragment.typeCondition?.name.value;
          const refinedType =
            typeName !== undefined
              ? this.operationContext.superSchema.getType(typeName)
              : parentType;

          invariant(
            isCompositeType(refinedType),
            `Invalid type condition ${inspect(refinedType)}`,
          );

          this._addFragment(refinedType, fragment, ownSelections, selectionMap);
          break;
        }
      }
    }
    return {
      ownSelections,
      selectionMap,
    };
  }

  _addField(
    parentType: GraphQLCompositeType,
    field: FieldNode,
    ownSelections: Array<SelectionNode>,
    selectionMap: AccumulatorMap<Subschema, SelectionNode>,
  ): void {
    const subschemaSetsByField =
      this.operationContext.superSchema.subschemaSetsByTypeAndField[
        parentType.name
      ];

    const subschemaSets = subschemaSetsByField[field.name.value];

    if (subschemaSets === undefined) {
      return;
    }

    const { subschema, selections } = this._getSubschemaAndSelections(
      subschemaSets,
      ownSelections,
      selectionMap,
    );

    if (!field.selectionSet) {
      selections.push(field);
      return;
    }

    const fieldName = field.name.value;
    const fieldDef = this._getFieldDef(parentType, fieldName);

    if (!fieldDef) {
      return;
    }

    const fieldType = fieldDef.type;

    const subFieldPlan = new FieldPlan(
      this.operationContext,
      getNamedType(fieldType) as GraphQLObjectType,
      field.selectionSet.selections,
      subschema,
    );

    if (subFieldPlan.ownSelections.length) {
      selections.push({
        ...field,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: subFieldPlan.ownSelections,
        },
      });
    }

    if (
      subFieldPlan.selectionMap.size > 0 ||
      Object.values(subFieldPlan.subFieldPlans).length > 0
    ) {
      const responseKey = field.alias?.value ?? field.name.value;

      this.subFieldPlans[responseKey] = subFieldPlan;
    }
  }

  _getSubschemaAndSelections(
    subschemas: Set<Subschema>,
    ownSelections: Array<SelectionNode>,
    selectionMap: Map<Subschema, Array<SelectionNode>>,
  ): {
    subschema: Subschema;
    selections: Array<SelectionNode>;
  } {
    if (this.subschema !== undefined && subschemas.has(this.subschema)) {
      return { subschema: this.subschema, selections: ownSelections };
    }

    let selections: Array<SelectionNode> | undefined;
    for (const subschema of subschemas) {
      selections = selectionMap.get(subschema);
      if (selections) {
        return { subschema, selections };
      }
    }

    selections = [];
    const subschema = subschemas.values().next().value as Subschema;
    selectionMap.set(subschema, selections);
    return { subschema, selections };
  }

  _getFieldDef(
    parentType: GraphQLCompositeType,
    fieldName: string,
  ): GraphQLField<any, any> | undefined {
    if (fieldName === '__typename') {
      return TypeNameMetaFieldDef;
    }

    invariant(
      isObjectType(parentType) || isInterfaceType(parentType),
      `Invalid parent type ${inspect(parentType)}.`,
    );

    const fields = parentType.getFields();

    const field = fields[fieldName];

    if (field !== undefined) {
      return field;
    }

    if (
      parentType ===
      this.operationContext.superSchema.mergedSchema.getQueryType()
    ) {
      switch (fieldName) {
        case SchemaMetaFieldDef.name:
          return SchemaMetaFieldDef;
        case TypeMetaFieldDef.name:
          return TypeMetaFieldDef;
      }
    }
  }

  _addFragment(
    parentType: GraphQLCompositeType,
    fragment: InlineFragmentNode | FragmentDefinitionNode,
    ownSelections: Array<SelectionNode>,
    selectionMap: AccumulatorMap<Subschema, SelectionNode>,
  ): void {
    const {
      ownSelections: fragmentOwnSelections,
      selectionMap: fragmentSelectionMap,
    } = this._processSelections(parentType, fragment.selectionSet.selections);

    if (fragmentOwnSelections.length > 0) {
      const splitFragment: InlineFragmentNode = {
        kind: Kind.INLINE_FRAGMENT,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: fragmentOwnSelections,
        },
      };
      ownSelections.push(splitFragment);
    }

    for (const [
      fragmentSubschema,
      fragmentSelections,
    ] of fragmentSelectionMap) {
      const splitFragment: InlineFragmentNode = {
        kind: Kind.INLINE_FRAGMENT,
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: fragmentSelections,
        },
      };
      selectionMap.add(fragmentSubschema, splitFragment);
    }
  }

  print(indent = 0): string {
    const entries = [];
    if (this.selectionMap.size > 0) {
      entries.push(this._printMap(indent));
    }

    const subFieldPlans = Array.from(Object.entries(this.subFieldPlans));
    if (subFieldPlans.length > 0) {
      entries.push(this._printSubFieldPlans(subFieldPlans, indent));
    }

    return entries.join('\n');
  }

  _printMap(indent: number): string {
    const spaces = new Array(indent).fill(' ', 0, indent).join('');
    let result = `${spaces}Map:\n`;
    result += Array.from(this.selectionMap.entries())
      .map(([subschema, selections]) =>
        this._printSubschemaSelections(subschema, selections, indent + 2),
      )
      .join('\n');
    return result;
  }

  _printSubschemaSelections(
    subschema: Subschema,
    selections: ReadonlyArray<SelectionNode>,
    indent: number,
  ): string {
    const spaces = new Array(indent).fill(' ', 0, indent).join('');
    let result = '';
    result += `${spaces}Subschema ${this.operationContext.superSchema.getSubschemaId(
      subschema,
    )}:\n`;
    result += `${spaces}  `;
    result += this._printSelectionSet(
      {
        kind: Kind.SELECTION_SET,
        selections,
      },
      indent + 2,
    );
    return result;
  }

  _printSubFieldPlans(
    subFieldPlans: ReadonlyArray<[string, FieldPlan]>,
    indent: number,
  ): string {
    return subFieldPlans
      .map(([responseKey, subFieldPlan]) =>
        this._printSubFieldPlan(responseKey, subFieldPlan, indent),
      )
      .join('\n');
  }

  _printSubFieldPlan(
    responseKey: string,
    subFieldPlan: FieldPlan,
    indent: number,
  ): string {
    const spaces = new Array(indent).fill(' ', 0, indent).join('');
    let subFieldPlanEntry = '';
    subFieldPlanEntry += `${spaces}SubFieldPlan for '${responseKey}':\n`;
    subFieldPlanEntry += subFieldPlan.print(indent + 2);
    return subFieldPlanEntry;
  }

  _printSelectionSet(selectionSet: SelectionSetNode, indent: number): string {
    const spaces = new Array(indent).fill(' ', 0, indent).join('');
    return print(selectionSet).split('\n').join(`\n${spaces}`);
  }
}
