export function createFoulTracker() {
  const list = [], fresh = []; let done = false;
  return { list, forcedLevel4: new Set(), onEvents() {}, drainNew: () => fresh.splice(0),
    update(sim, match) { if (!done && match.elapsed > 4) { done = true; const f = { t: match.elapsed, rule: 'G103', type: 'tech', against: 'red', robotId: 'red-0', text: 'Contact in protected SCORING ZONE' }; list.push(f); fresh.push(f); } } };
}
