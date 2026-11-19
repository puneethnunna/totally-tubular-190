export function computeScore(sim, match) {
  const s = (a) => ({ auto: { floor: 0, lower: 0, upper: 0 }, teleop: { floor: 0, lower: 0, upper: 0 }, platform: { levels: [0, 0, 0], points: a === 'blue' ? 10 : 0 }, fouls: { foul: 0, tech: 0, points: 0 }, tubePoints: 0, total: Math.floor(match.elapsed / 3) * (a === 'blue' ? 1 : 2), fullPosts: Math.floor(match.elapsed / 20), rp: { win: 0, posts8: 0, posts12: 0, platform16: 0, total: 0 } });
  return { blue: s('blue'), red: s('red') };
}
