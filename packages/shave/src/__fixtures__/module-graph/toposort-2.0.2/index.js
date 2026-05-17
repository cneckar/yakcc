/**
 * Topological sorting function
 *
 * @param {Array} edges
 * @returns {Array}
 *
 * @decision DEC-WI510-S13-ENTRY-PATH-INDEX-CJS-001
 *   title: Slice 13 entry is index.js (the ONLY entry; no ESM alternative)
 *   status: accepted
 *   rationale: toposort@2.0.2 ships pure-CJS only: no package.json#module, no
 *   package.json#exports, no esm/ subdir. index.js is hand-authored CJS (Marcel
 *   Klehr 2012-2018) with module.exports = function(...) {...} +
 *   module.exports.array = identifier. Engine bypasses package.json resolution
 *   via explicit entryPath (same pattern as S5/S6/S7/S8/S10/S11/S12).
 *
 * @decision DEC-WI510-S13-CJS-EXPORT-SHAPE-001
 *   title: module.exports = FunctionExpression + module.exports.X = Identifier combo
 *   status: accepted
 *   rationale: Validated regime: S1 ms, S6 jsonwebtoken/decode.js/sign.js/verify.js,
 *   three-module-pkg. Engine decompose() has handled this CJS export-shape across
 *   Slices 1/2/6/7.
 *
 * @decision DEC-WI510-S13-VAR-FUNCTION-DECL-001
 *   title: Pre-ES2015 var + function name(){} declarations decompose identically
 *   status: accepted
 *   rationale: Engine treats VariableDeclaration kind="var" identically to let/const;
 *   function declarations identically to function expressions for body-traversal.
 *   Validated through S7 lodash extensive function name(...) {} usage.
 */

module.exports = function(edges) {
  return toposort(uniqueNodes(edges), edges)
}

module.exports.array = toposort

function toposort(nodes, edges) {
  var cursor = nodes.length
    , sorted = new Array(cursor)
    , visited = {}
    , i = cursor
    // Better data structures make algorithm much faster.
    , outgoingEdges = makeOutgoingEdges(edges)
    , nodesHash = makeNodesHash(nodes)

  // check for unknown nodes
  edges.forEach(function(edge) {
    if (!nodesHash.has(edge[0]) || !nodesHash.has(edge[1])) {
      throw new Error('Unknown node. There is an unknown node in the supplied edges.')
    }
  })

  while (i--) {
    if (!visited[i]) visit(nodes[i], i, new Set())
  }

  return sorted

  function visit(node, i, predecessors) {
    if(predecessors.has(node)) {
      var nodeRep
      try {
        nodeRep = ", node was:" + JSON.stringify(node)
      } catch(e) {
        nodeRep = ""
      }
      throw new Error('Cyclic dependency' + nodeRep)
    }

    if (!nodesHash.has(node)) {
      throw new Error('Found unknown node. Make sure to provided all involved nodes. Unknown node: '+JSON.stringify(node))
    }

    if (visited[i]) return;
    visited[i] = true

    var outgoing = outgoingEdges.get(node) || new Set()
    outgoing = Array.from(outgoing)

    if (i = outgoing.length) {
      predecessors.add(node)
      do {
        var child = outgoing[--i]
        visit(child, nodesHash.get(child), predecessors)
      } while (i)
      predecessors.delete(node)
    }

    sorted[--cursor] = node
  }
}

function uniqueNodes(arr){
  var res = new Set()
  for (var i = 0, len = arr.length; i < len; i++) {
    var edge = arr[i]
    res.add(edge[0])
    res.add(edge[1])
  }
  return Array.from(res)
}

function makeOutgoingEdges(arr){
  var edges = new Map()
  for (var i = 0, len = arr.length; i < len; i++) {
    var edge = arr[i]
    if (!edges.has(edge[0])) edges.set(edge[0], new Set())
    if (!edges.has(edge[1])) edges.set(edge[1], new Set())
    edges.get(edge[0]).add(edge[1])
  }
  return edges
}

function makeNodesHash(arr){
  var res = new Map()
  for (var i = 0, len = arr.length; i < len; i++) {
    res.set(arr[i], i)
  }
  return res
}
