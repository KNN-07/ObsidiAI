import { Type } from '@earendil-works/pi-ai';
import type { Static } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { note, page, pagination, result, type MetadataService } from './metadata-tools';

type Direction = 'incoming' | 'outgoing' | 'both';
const direction = Type.Optional(Type.Union([Type.Literal('incoming'), Type.Literal('outgoing'), Type.Literal('both')]));
export function createGraphTool(service: MetadataService) {
  const parameters = Type.Union([
    Type.Object({ operation: Type.Union([Type.Literal('backlinks'), Type.Literal('outlinks')]), path: Type.String(), ...pagination }),
    Type.Object({ operation: Type.Literal('neighbors'), path: Type.String(), depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })), direction, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
    Type.Object({ operation: Type.Literal('shortest_path'), from: Type.String(), to: Type.String(), direction, maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), maxVisited: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })) }),
    Type.Object({ operation: Type.Literal('unresolved'), path: Type.Optional(Type.String()), ...pagination }),
    Type.Object({ operation: Type.Literal('orphans'), ...pagination }),
  ]);
  const tool: AgentTool<typeof parameters> = { name: 'query_graph', label: 'Query native graph', description: 'Bounded graph queries using native resolved/unresolved link counts. Only scoped Markdown nodes; provisional cache results are not definitive vault absence.', parameters, executionMode: 'sequential', execute: async (_id, args: Static<typeof parameters>, signal) => {
    const app = service.app; const q = await service.snapshot(signal); const paths = new Set(q.files.map(f => f.path));
    const endpoint = (path: string) => { note(app, path); if (!paths.has(path)) throw new Error('Endpoint changed; rerun the query'); return path; };
    const finish = (data: object) => { q.check(); return result({ operation: args.operation, ...data, ...q.info() }); };
    if (args.operation === 'unresolved') {
      if (args.path !== undefined) endpoint(args.path);
      const items: { source: string; linktext: string; count: number }[] = [];
      for (const file of q.files) { if (args.path !== undefined && file.path !== args.path) continue; for (const [linktext, count] of Object.entries(app.metadataCache.unresolvedLinks[file.path] ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) { await q.tick(); items.push({ source: file.path, linktext, count }); } await q.tick(); }
      return finish(page(items, args.offset, args.limit));
    }
    const dir: Direction = 'direction' in args ? args.direction ?? 'both' : args.operation === 'outlinks' ? 'outgoing' : 'both';
    const needsIncoming = args.operation === 'backlinks' || args.operation === 'orphans' || dir !== 'outgoing';
    const incoming = new Map<string, Map<string, number>>();
    if (needsIncoming) for (const source of paths) {
      for (const [destination, count] of Object.entries(app.metadataCache.resolvedLinks[source] ?? {})) { await q.tick(); if (!paths.has(destination)) continue; let sources = incoming.get(destination); if (!sources) incoming.set(destination, sources = new Map()); sources.set(source, count); } await q.tick();
    }
    const adjacent = async (path: string, traversal: Direction, includeSelf = false) => {
      const neighbors = new Set<string>();
      if (traversal !== 'incoming') for (const destination of Object.keys(app.metadataCache.resolvedLinks[path] ?? {})) { await q.tick(); if (paths.has(destination) && (includeSelf || destination !== path)) neighbors.add(destination); }
      if (traversal !== 'outgoing') for (const source of incoming.get(path)?.keys() ?? []) { await q.tick(); if (includeSelf || source !== path) neighbors.add(source); }
      return [...neighbors].sort();
    };
    if (args.operation === 'backlinks' || args.operation === 'outlinks') {
      const path = endpoint(args.path); const nodes = await adjacent(path, args.operation === 'backlinks' ? 'incoming' : 'outgoing', true);
      const edges = nodes.map(other => args.operation === 'backlinks' ? { source: other, destination: path, count: incoming.get(path)!.get(other)! } : { source: path, destination: other, count: app.metadataCache.resolvedLinks[path]![other]! });
      const paged = page(edges, args.offset, args.limit);
      return finish({ ...paged, nodes: [...new Set(paged.results.flatMap(e => [e.source, e.destination]))].sort() });
    }
    if (args.operation === 'orphans') {
      const items: { path: string }[] = []; let skippedUnindexed = 0;
      for (const file of q.files) { await q.tick(); if (!app.metadataCache.getFileCache(file)) { skippedUnindexed++; continue; } if (!(await adjacent(file.path, 'both')).length) items.push({ path: file.path }); }
      return finish({ ...page(items, args.offset, args.limit), skippedUnindexed });
    }
    if (args.operation === 'neighbors') {
      const start = endpoint(args.path); const depth = args.depth ?? 1; const limit = args.limit ?? 200;
      if (!Number.isInteger(depth) || depth < 1 || depth > 3 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid neighborhood bounds');
      const distance = new Map([[start, 0]]); const queue = [start]; let truncated = false;
      for (let i = 0; i < queue.length; i++) { const source = queue[i]!; if (distance.get(source)! >= depth) continue; for (const destination of await adjacent(source, dir)) { if (distance.has(destination)) continue; if (queue.length >= limit) { truncated = true; continue; } distance.set(destination, distance.get(source)! + 1); queue.push(destination); } }
      const edges: { source: string; destination: string; count: number }[] = []; let omittedEdgeCount = 0;
      for (const source of [...distance.keys()].sort()) for (const [destination, count] of Object.entries(app.metadataCache.resolvedLinks[source] ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) { await q.tick(); if (source !== destination && distance.has(destination)) { if (edges.length < 200) edges.push({ source, destination, count }); else omittedEdgeCount++; } }
      return finish({ nodes: [...distance.keys()].sort().map(path => ({ path, depth: distance.get(path) })), edges, omittedEdgeCount, truncated: truncated || omittedEdgeCount > 0 });
    }
    if (args.operation !== 'shortest_path') throw new Error('Unknown graph operation');
    const from = endpoint(args.from); const to = endpoint(args.to); const maxDepth = args.maxDepth ?? 8; const maxVisited = args.maxVisited ?? 1000;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 20 || !Number.isInteger(maxVisited) || maxVisited < 1 || maxVisited > 5000) throw new Error('Invalid shortest-path bounds');
    if (from === to) return finish({ status: 'found', nodes: [from], edges: [], visited: 1, truncated: false });
    const parents = new Map<string, string | null>([[from, null]]); const depths = new Map([[from, 0]]); const queue = [from]; let bounded = false; let found = false;
    for (let i = 0; i < queue.length && !found; i++) {
      const source = queue[i]!; const depth = depths.get(source)!;
      for (const destination of await adjacent(source, dir)) {
        if (parents.has(destination)) continue;
        if (depth >= maxDepth || parents.size >= maxVisited) { bounded = true; continue; }
        parents.set(destination, source); depths.set(destination, depth + 1); queue.push(destination);
        if (destination === to) { found = true; break; }
      }
    }
    if (!found) return finish({ status: bounded ? 'search_limit_reached' : 'no_path_in_cached_graph', nodes: [], edges: [], visited: parents.size, truncated: bounded });
    const nodes: string[] = []; for (let p: string | null = to; p !== null; p = parents.get(p) ?? null) nodes.push(p); nodes.reverse();
    const edges = nodes.slice(1).map((destination, index) => { const source = nodes[index]!; return { from: source, to: destination, outgoingCount: app.metadataCache.resolvedLinks[source]?.[destination] ?? 0, incomingCount: app.metadataCache.resolvedLinks[destination]?.[source] ?? 0 }; });
    return finish({ status: 'found', nodes, edges, visited: parents.size, truncated: false });
  } };
  return tool;
}
