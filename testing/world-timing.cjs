// Flushing telemetry is not a disconnect. Keep the last observed tick so a
// pause spanning two telemetry blocks is included in the reported maximum.
module.exports = function createTimingAccumulator() {
  const previous = new Map();
  return {
    reset(client) { previous.delete(client); },
    collect(client, ticks) {
      const gaps = [];
      for (const tick of ticks) {
        const last = previous.get(client);
        if (last !== undefined && tick > last) gaps.push(tick - last);
        if (last === undefined || tick > last) previous.set(client, tick);
      }
      return gaps;
    },
  };
};
