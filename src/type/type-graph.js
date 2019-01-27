// @flow
import traverseTree from "../utils/traverse";
import NODE from "../utils/nodes";
import { Option } from "../utils/option";
import mixBaseOperators from "../utils/operators";
import {
  findVariableInfo,
  getInvocationType,
  getTypeFromTypeAnnotation,
  getFunctionTypeLiteral
} from "../utils/utils";
import {
  Type,
  CallMeta,
  ObjectType,
  FunctionType,
  GenericType,
  VariableInfo,
  Scope,
  Meta,
  ModuleScope,
  UNDEFINED_TYPE,
  TYPE_SCOPE
} from "./types";
import type {
  Program,
  SourceLocation,
  Node,
  TypeAnnotation,
  TypeParameter,
  Declaration
} from "@babel/parser";

const getScopeType = (node: Node): $PropertyType<Scope, "type"> => {
  switch (node.type) {
    case NODE.BLOCK_STATEMENT:
      return Scope.BLOCK_TYPE;
    case NODE.FUNCTION_DECLARATION:
    case NODE.FUNCTION_EXPRESSION:
    case NODE.ARROW_FUNCTION_EXPRESSION:
    case NODE.OBJECT_METHOD:
    case NODE.FUNCTION_TYPE_ANNOTATION:
      return Scope.FUNCTION_TYPE;
    case NODE.OBJECT_EXPRESSION:
      return Scope.OBJECT_TYPE;
    case NODE.CLASS_DECLARATION:
    case NODE.CLASS_EXPRESSION:
      return Scope.CLASS_TYPE;
  }
  throw new TypeError("Never for getScopeType");
};

const getTypeScope = (scope: Scope | ModuleScope): Scope => {
  const typeScope = scope.body.get(TYPE_SCOPE);
  if (typeScope instanceof Scope) {
    return typeScope;
  }
  if (scope.parent) {
    return getTypeScope(scope.parent);
  }
  throw new TypeError("Never");
};

const getTypeForNode = (
  currentNode: Node,
  typeGraph: ModuleScope,
  parentNode?: Node | ModuleScope | Scope = currentNode
): Type => {
  const typeAnnotation = currentNode.id && currentNode.id.typeAnnotation;
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (!typeScope || !(typeScope instanceof Scope)) {
    throw new Error("Type scope is not a scope.");
  }
  const defaultType = getTypeFromTypeAnnotation(typeAnnotation, typeScope);
  if (typeAnnotation) {
    return defaultType;
  }
  switch (currentNode.type) {
    case NODE.NUMERIC_LITERAL:
      return Type.createTypeWithName("number", parentNode);
    case NODE.STRING_LITERAL:
      return Type.createTypeWithName("string", parentNode);
    case NODE.BOOLEAN_LITERAL:
      return Type.createTypeWithName("boolean", parentNode);
    case NODE.NULL_LITERAL:
      return Type.createTypeWithName(null, parentNode);
    case NODE.REG_EXP_LITERAL:
      return ObjectType.createTypeWithName("RegExp", parentNode);
    case NODE.IDENTIFIER:
      const [variableInfo] = findVariableInfo(
        currentNode,
        parentNode,
        typeGraph
      );
      return variableInfo.type;
    case NODE.OBJECT_EXPRESSION:
      return getTypeFromInit(currentNode, parentNode, typeGraph, defaultType);
    case NODE.VARIABLE_DECLARATOR:
      return getTypeFromInit(
        currentNode.init,
        parentNode,
        typeGraph,
        defaultType
      );
    case NODE.OBJECT_METHOD:
    case NODE.FUNCTION_DECLARATION:
    case NODE.FUNCTION_EXPRESSION:
    case NODE.ARROW_FUNCTION_EXPRESSION:
      const params = currentNode.params.map(a =>
        getTypeFromTypeAnnotation(a.typeAnnotation, typeScope)
      );
      const returnType = getTypeFromTypeAnnotation(
        currentNode.returnType,
        typeScope
      );
      const typeName = getFunctionTypeLiteral(params, returnType);
      return currentNode.typeParameters
        ? GenericType.createTypeWithName(
            currentNode.id ? currentNode.id.name : typeName,
            typeScope,
            currentNode.typeParameters.params,
            typeScope,
            Object.assign(currentNode, { type: NODE.FUNCTION_TYPE_ANNOTATION })
          )
        : FunctionType.createTypeWithName(
            typeName,
            typeScope,
            params,
            returnType
          );
    default:
      return defaultType;
  }
};

const addCallToTypeGraph = (
  node: Node,
  typeGraph: ModuleScope,
  currentScope: Scope | ModuleScope
): Type => {
  const typeScope = getTypeScope(currentScope);
  let target = null;
  let args = null;
  switch (node.type) {
    case NODE.EXPRESSION_STATEMENT:
      return addCallToTypeGraph(node.expression, typeGraph, currentScope);
    case NODE.RETURN_STATEMENT:
    case NODE.UNARY_EXPRESSION:
      args = [addCallToTypeGraph(node.argument, typeGraph, currentScope)];
      target = typeScope.body.get(node.operator || "return");
      break;
    case NODE.BINARY_EXPRESSION:
    case NODE.LOGICAL_EXPRESSION:
      args = [
        addCallToTypeGraph(node.left, typeGraph, currentScope),
        addCallToTypeGraph(node.right, typeGraph, currentScope)
      ];
      target = typeScope.body.get(node.operator);
      break;
    case NODE.ASSIGNMENT_EXPRESSION:
      args = [
        getTypeForNode(node.left, typeGraph, currentScope),
        addCallToTypeGraph(node.right, typeGraph, currentScope)
      ];
      target = typeScope.body.get(node.operator);
      break;
    case NODE.CONDITIONAL_EXPRESSION:
      args = [
        addCallToTypeGraph(node.test, typeGraph, currentScope),
        addCallToTypeGraph(node.conseqent, typeGraph, currentScope),
        addCallToTypeGraph(node.alternate, typeGraph, currentScope)
      ];
      target = typeScope.body.get("?:");
      break;
    case NODE.CALL_EXPRESSION:
      args = node.arguments.map(n =>
        addCallToTypeGraph(n, typeGraph, currentScope)
      );
      target = typeScope.body.get(node.callee);
      break;
    default:
      return getTypeForNode(node, typeGraph, currentScope);
  }
  if (!(target instanceof VariableInfo)) {
    throw new Error("Never!");
  }
  currentScope.calls.push(new CallMeta(target.type, args, node.loc));
  return getInvocationType(target);
};

const getTypeFromInit = (
  currentInit: Node,
  parentNode: Node,
  typeGraph: ModuleScope,
  defaultType: Type
): Type => {
  switch (currentInit.type) {
    case NODE.OBJECT_EXPRESSION:
      return ObjectType.createTypeWithName(
        UNDEFINED_TYPE,
        typeGraph.body.get(TYPE_SCOPE),
        currentInit.properties.reduce(
          (types, field) =>
            types.concat([
              [
                field.key.name,
                getVariableInfoFromDelcaration(
                  field.value || field,
                  parentNode,
                  typeGraph
                )
              ]
            ]),
          []
        )
      );
    default:
      return defaultType;
  }
};

const getScopeKey = (node: Node) =>
  `[[Scope${node.loc.start.line}-${node.loc.start.column}]]`;

const getDeclarationName = (node: Declaration): string => node.id.name;

const findNearestScopeByType = (
  type: $PropertyType<Scope, "type">,
  parentContext: ModuleScope | Scope
): Scope | ModuleScope => {
  let parent = parentContext;
  while (parent instanceof Scope) {
    if (parent.type === type) {
      return parent;
    }
    parent = parent.parent;
  }
  return parent;
};

const getParentFromNode = (
  currentNode: Node,
  parentNode: ?Node,
  typeGraph: ModuleScope
): ModuleScope | Scope => {
  if (!parentNode) {
    return typeGraph;
  }
  const name = getScopeKey(parentNode);
  const scope = typeGraph.body.get(name);
  if (!(scope instanceof Scope)) {
    return typeGraph;
  }
  if (NODE.isUnscopableDeclaration(currentNode)) {
    return findNearestScopeByType(Scope.FUNCTION_TYPE, scope || typeGraph);
  }
  return scope;
};

const getVariableInfoFromDelcaration = (
  currentNode: Node,
  parent: Node | ModuleScope | Scope,
  typeGraph: ModuleScope
) => {
  const parentScope =
    parent instanceof ModuleScope || parent instanceof Scope
      ? parent
      : getParentFromNode(currentNode, parent, typeGraph);
  return new VariableInfo(
    /*type:*/ addCallToTypeGraph(currentNode, typeGraph, parentScope),
    parentScope,
    /*meta:*/ new Meta(currentNode.loc)
  );
};

const getScopeFromNode = (
  currentNode: Node,
  parentNode: Node | ModuleScope | Scope,
  typeGraph: ModuleScope,
  declaration?: VariableInfo
) =>
  new Scope(
    /*type:*/ getScopeType(currentNode),
    /*parent:*/ parentNode instanceof Scope || parentNode instanceof ModuleScope
      ? parentNode
      : getParentFromNode(currentNode, parentNode, typeGraph),
    /* declaration */ declaration
  );

const addVariableToGraph = (
  currentNode: Node,
  parentNode: ?Node | Scope,
  typeGraph: ModuleScope,
  customName?: string = getDeclarationName(currentNode)
) => {
  const variableInfo = getVariableInfoFromDelcaration(
    currentNode,
    parentNode,
    typeGraph
  );
  variableInfo.parent.body.set(customName, variableInfo);
  return variableInfo;
};

type FunctionMeta = {
  type?: FunctionType,
  name?: string
};

const addFunctionScopeToTypeGraph = (
  currentNode: Node,
  parentNode: Node | Scope | ModuleScope,
  typeGraph: ModuleScope,
  variableInfo: VariableInfo
) => {
  const scope = getScopeFromNode(
    currentNode,
    parentNode,
    typeGraph,
    variableInfo
  );
  typeGraph.body.set(getScopeKey(currentNode), scope);
  if (currentNode.type === NODE.FUNCTION_EXPRESSION && currentNode.id) {
    scope.body.set(getDeclarationName(currentNode), variableInfo);
  }
  currentNode.params.forEach(id =>
    addVariableToGraph({ id }, scope, typeGraph)
  );
};

const addFunctionToTypeGraph = (
  currentNode: Node,
  parentNode: Node,
  typeGraph: ModuleScope,
  meta: FunctionMeta
) => {
  const variableInfo = addVariableToGraph(
    currentNode,
    parentNode,
    typeGraph,
    meta.name
  );
  if (meta.type) {
    variableInfo.type = meta.type;
  }
  addFunctionScopeToTypeGraph(currentNode, parentNode, typeGraph, variableInfo);
};

const addObjectMethodToGraph = (
  currentNode: Node,
  parentNode: Node | Scope | ModuleScope,
  typeGraph: ModuleScope,
  objectVariableInfo: VariableInfo
): void => {
  currentNode.properties.forEach(field => {
    const declaration =
      objectVariableInfo.type instanceof ObjectType
        ? objectVariableInfo.type.properties.get(field.key.name)
        : null;
    if (!declaration) {
      return;
    }
    if (NODE.isFunctionalProperty(field)) {
      return addFunctionScopeToTypeGraph(
        field.value || field,
        currentNode,
        typeGraph,
        declaration
      );
    }
    if (NODE.isObject(field.value)) {
      return addObjectMethodToGraph(
        field.value,
        currentNode,
        typeGraph,
        declaration
      );
    }
  });
};

const hasTypeParams = (node: Node): boolean =>
  node.typeParameters &&
  node.typeParameters.type === NODE.TYPE_PARAMETER_DECLARATION &&
  Array.isArray(node.typeParameters.params) &&
  node.typeParameters.params.length !== 0;

const getGenericNode = (node: Node): ?Node => {
  if (hasTypeParams(node)) {
    return node;
  }
  if (node.right && hasTypeParams(node.right)) {
    return node.right;
  }
  return null;
};

const addTypeAlias = (node: Node, typeGraph: ModuleScope) => {
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (typeScope === undefined || !(typeScope instanceof Scope)) {
    throw new Error(
      "Type scope should be presented before type alias has been met"
    );
  }
  const genericNode = getGenericNode(node);
  const typeFor = genericNode
    ? GenericType.createTypeWithName(
        node.id.name,
        typeScope,
        genericNode.typeParameters.params,
        typeScope,
        node.right
      )
    : getTypeFromTypeAnnotation({ typeAnnotation: node.right }, typeScope);
  typeScope.body.set(
    node.id.name,
    new VariableInfo(typeFor, typeScope, new Meta(node.loc))
  );
};

const fillModuleScope = (typeGraph: ModuleScope) => {
  const typeScope = typeGraph.body.get(TYPE_SCOPE);
  if (!typeScope || !(typeScope instanceof Scope)) {
    throw new Error("Type scope is not a scope.");
  }
  return function filler(
    currentNode: Node,
    parentNode: Node | Scope | ModuleScope,
    meta?: Object = {}
  ) {
    switch (currentNode.type) {
      case NODE.RETURN_STATEMENT:
      case NODE.EXPRESSION_STATEMENT:
        addCallToTypeGraph(
          currentNode,
          typeGraph,
          getParentFromNode(currentNode, parentNode, typeGraph)
        );
        break;
      case NODE.TYPE_ALIAS:
        addTypeAlias(currentNode, typeGraph);
        break;
      case NODE.VARIABLE_DECLARATION:
        const parent = getParentFromNode(currentNode, parentNode, typeGraph);
        currentNode.declarations.forEach(node => filler(node, parent, meta));
        break;
      case NODE.BLOCK_STATEMENT:
        if (NODE.isFunction(parentNode)) {
          return;
        }
      case NODE.CLASS_DECLARATION:
      case NODE.CLASS_EXPRESSION:
        typeGraph.body.set(
          getScopeKey(currentNode),
          getScopeFromNode(currentNode, parentNode, typeGraph)
        );
        break;
      case NODE.VARIABLE_DECLARATOR:
        if (NODE.isFunction(currentNode.init)) {
          return filler(currentNode.init, parentNode, {
            name: currentNode.id.name,
            type: currentNode.id.typeAnnotation
              ? getTypeFromTypeAnnotation(
                  currentNode.id.typeAnnotation,
                  typeScope
                )
              : null
          });
        }
        if (NODE.isObject(currentNode.init)) {
          const objectVariableInfo = addVariableToGraph(
            currentNode,
            parentNode,
            typeGraph
          );
          addObjectMethodToGraph(
            currentNode.init,
            parentNode,
            typeGraph,
            objectVariableInfo
          );
          return;
        }
        addVariableToGraph(currentNode, parentNode, typeGraph);
        break;
      case NODE.FUNCTION_EXPRESSION:
      case NODE.ARROW_FUNCTION_EXPRESSION:
      case NODE.CLASS_DECLARATION:
      case NODE.FUNCTION_DECLARATION:
        addFunctionToTypeGraph(currentNode, parentNode, typeGraph, meta);
        break;
    }
  };
};

const createModuleScope = (ast: Program): ModuleScope => {
  const result = new ModuleScope();
  const typeScope = new Scope("block", result);
  mixBaseOperators(typeScope);
  result.body.set(TYPE_SCOPE, typeScope);
  traverseTree(ast, fillModuleScope(result));
  return result;
};

export default createModuleScope;