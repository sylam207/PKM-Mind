import { mergeHiddenBranchesById, normalizeJsonWithStableIds } from "./tree-utils.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function testNormalizeAddsIds() {
  const source = {
    nodes: [{ text: "Root", children: [{ text: "Child" }] }]
  };
  const { normalized, nextId } = normalizeJsonWithStableIds(source, 1);
  const root = normalized.nodes[0];
  const child = root.children[0];

  assert(Number.isInteger(root.id), "Root should have an ID");
  assert(Number.isInteger(child.id), "Child should have an ID");
  assert(nextId > child.id, "nextId should move past max ID");
}

function testMergePreservesHiddenById() {
  const visible = {
    nodes: [{ id: 1, text: "Root", children: [{ id: 2, text: "A", children: [] }] }]
  };
  const original = {
    nodes: [{
      id: 1,
      text: "Root",
      children: [
        { id: 2, text: "A", children: [] },
        { id: 99, text: "Hidden", hidden: true, children: [] }
      ]
    }]
  };

  const merged = mergeHiddenBranchesById(visible, original);
  const mergedChildren = merged.nodes[0].children;
  assert(mergedChildren.some((node) => node.id === 99), "Hidden child should be preserved by ID");
}

function runTests() {
  testNormalizeAddsIds();
  testMergePreservesHiddenById();
  console.log("tree-utils tests passed");
}

runTests();
