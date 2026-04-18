export class AnalysisEngine {
  static CONFIG = {
    backtestRounds: 24,
    minHistory: 12,
    take: 10,
    weights: {
      antiRepeat: 0.40,
      deltaShift: 0.25,
      gap: 0.20,
      novelty: 0.15
    }
  };

  static run(data) {
    const clean = this.prepare(data);
    if (clean.length < this.CONFIG.minHistory + 1) {
      throw new Error("ข้อมูลย้อนหลังไม่พอสำหรับวิเคราะห์");
    }

    const latest = clean[0];
    const history = clean.slice(1);

    const regime = this.detectRegime(clean);

    const top2Scored = this.scoreAll(
      this.gen2(),
      latest.last2,
      history.map(x => x.last2),
      regime,
      2
    );

    const top3Scored = this.scoreAll(
      this.gen3(),
      latest.top3,
      history.map(x => x.top3),
      regime,
      3
    );

    const bottom3Scored = this.scoreAll(
      this.gen3(),
      latest.bottom3[0],
      history.flatMap(x => x.bottom3),
      regime,
      3
    );

    return {
      latest,
      history,
      regime,
      forecastNow: {
        last2: this.top(top2Scored),
        top3: this.top(top3Scored),
        bottom3: this.top(bottom3Scored),
        hybrid: this.buildHybrid(
          this.top(top3Scored),
          this.top(bottom3Scored)
        )
      }
    };
  }

  static prepare(data) {
    return [...data]
      .filter(d =>
        d &&
        typeof d.date === "string" &&
        typeof d.firstPrize === "string" &&
        typeof d.top3 === "string" &&
        typeof d.last2 === "string" &&
        Array.isArray(d.front3) &&
        Array.isArray(d.bottom3)
      )
      .map(d => ({
        date: d.date,
        firstPrize: String(d.firstPrize).padStart(6, "0"),
        top3: String(d.top3).padStart(3, "0"),
        last2: String(d.last2).padStart(2, "0"),
        front3: d.front3.map(x => String(x).padStart(3, "0")).slice(0, 2),
        bottom3: d.bottom3.map(x => String(x).padStart(3, "0")).slice(0, 2)
      }))
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  static gen2() {
    const arr = [];
    for (let i = 0; i < 100; i++) {
      arr.push(String(i).padStart(2, "0"));
    }
    return arr;
  }

  static gen3() {
    const arr = [];
    for (let i = 0; i < 1000; i++) {
      arr.push(String(i).padStart(3, "0"));
    }
    return arr;
  }

  static top(scored) {
    const sorted = [...scored].sort((a, b) => b.score - a.score).slice(0, this.CONFIG.take);
    const max = sorted[0]?.score ?? 1;
    const min = sorted[sorted.length - 1]?.score ?? 0;
    const span = Math.max(max - min, 0.000001);

    return sorted.map(item => ({
      num: item.num,
      score: item.score,
      percent: Number((42 + ((item.score - min) / span) * 58).toFixed(2))
    }));
  }

  static buildHybrid(top3, bottom3) {
    const map = {};

    top3.forEach((item, idx) => {
      map[item.num] = (map[item.num] || 0) + ((12 - idx) * 1.0) + (item.percent * 0.02);
    });

    bottom3.forEach((item, idx) => {
      map[item.num] = (map[item.num] || 0) + ((12 - idx) * 0.92) + (item.percent * 0.018);
    });

    const ranked = Object.entries(map)
      .map(([num, score]) => ({ num, score }))
      .sort((a, b) => b.score - a.score);

    const max = ranked[0]?.score ?? 1;
    const min = ranked[ranked.length - 1]?.score ?? 0;
    const span = Math.max(max - min, 0.000001);

    return ranked.slice(0, this.CONFIG.take).map(item => ({
      num: item.num,
      score: item.score,
      percent: Number((42 + ((item.score - min) / span) * 58).toFixed(2))
    }));
  }
}
AnalysisEngine.detectRegime = function(data) {
  const shortWindow = data.slice(0, 8);
  const midWindow = data.slice(0, 24);

  const shortTop3 = shortWindow.map(x => x.top3);
  const midTop3 = midWindow.map(x => x.top3);

  const shortUniqueDigits = this.countUniqueDigits(shortTop3);
  const midUniqueDigits = this.countUniqueDigits(midTop3);

  const repeatRatio = this.calcRepeatRatio(shortTop3);
  const overlapRatio = this.calcOverlapRatio(shortTop3);

  return {
    highRepeat: repeatRatio >= 0.34,
    highOverlap: overlapRatio >= 0.62,
    spreadUp: shortUniqueDigits > midUniqueDigits,
    spreadDown: shortUniqueDigits < midUniqueDigits
  };
};

AnalysisEngine.countUniqueDigits = function(values) {
  const set = new Set();
  values.forEach(v => v.split("").forEach(d => set.add(d)));
  return set.size;
};

AnalysisEngine.calcRepeatRatio = function(values) {
  let repeat = 0;
  let total = 0;

  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] === values[i]) repeat++;
    total++;
  }

  return total ? repeat / total : 0;
};

AnalysisEngine.calcOverlapRatio = function(values) {
  let overlap = 0;
  let total = 0;

  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    const pool = b.split("");

    let hit = 0;
    a.split("").forEach(d => {
      const idx = pool.indexOf(d);
      if (idx !== -1) {
        hit++;
        pool.splice(idx, 1);
      }
    });

    overlap += hit / a.length;
    total++;
  }

  return total ? overlap / total : 0;
};

AnalysisEngine.scoreAll = function(candidates, latest, historyValues, regime, digits) {
  return candidates.map(num => {
    let score = 0;

    score += this.antiRepeat(num, latest, digits) * this.CONFIG.weights.antiRepeat;
    score += this.deltaShift(num, historyValues, digits) * this.CONFIG.weights.deltaShift;
    score += this.gapScore(num, historyValues) * this.CONFIG.weights.gap;
    score += this.novelty(num, historyValues) * this.CONFIG.weights.novelty;

    if (regime.highRepeat) score *= 0.88;
    if (regime.highOverlap && this.sharedDigitsRatio(num, latest) > 0.66) score *= 0.72;
    if (regime.spreadUp && new Set(num.split("")).size === digits) score *= 1.08;
    if (regime.spreadDown && new Set(num.split("")).size === 1) score *= 0.82;

    return { num, score };
  });
};

AnalysisEngine.sharedDigitsRatio = function(a, b) {
  const pool = b.split("");
  let hit = 0;

  a.split("").forEach(d => {
    const idx = pool.indexOf(d);
    if (idx !== -1) {
      hit++;
      pool.splice(idx, 1);
    }
  });

  return hit / a.length;
};

AnalysisEngine.samePositionCount = function(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) count++;
  }
  return count;
};

AnalysisEngine.antiRepeat = function(num, latest, digits) {
  let score = 1.0;

  if (num === latest) return -10;

  const samePos = this.samePositionCount(num, latest);
  const shared = this.sharedDigitsRatio(num, latest);

  if (samePos === digits) score -= 5.0;
  else if (samePos === digits - 1) score -= 2.4;
  else if (samePos === 1) score -= 0.7;

  if (shared === 1) score -= 2.0;
  else if (shared >= 0.66) score -= 1.1;
  else if (shared >= 0.5) score -= 0.5;

  if (digits === 3 && new Set(num.split("")).size === 1) score -= 0.8;
  if (digits === 2 && num[0] === num[1]) score -= 0.4;

  return score;
};
AnalysisEngine.deltaShift = function(num, historyValues, digits) {
  const short = historyValues.slice(0, 8);
  const mid = historyValues.slice(0, 24);
  const long = historyValues.slice(0, 80);

  const shortPos = this.positionProfile(short, digits);
  const midPos = this.positionProfile(mid, digits);
  const longPos = this.positionProfile(long, digits);

  let score = 0;

  for (let i = 0; i < digits; i++) {
    const d = num[i];
    const s = shortPos[i][d] || 0;
    const m = midPos[i][d] || 0;
    const l = longPos[i][d] || 0;

    const momentum = (s - m) + ((m - l) * 0.5);
    score += momentum;
  }

  const shortPairs = this.pairProfile(short, digits);
  const midPairs = this.pairProfile(mid, digits);

  for (let i = 0; i < digits - 1; i++) {
    const pair = num.slice(i, i + 2);
    score += ((shortPairs[pair] || 0) - (midPairs[pair] || 0)) * 0.8;
  }

  return score;
};

AnalysisEngine.positionProfile = function(values, digits) {
  const out = Array.from({ length: digits }, () => ({}));

  values.forEach((v, idx) => {
    const w = 1 / (1 + idx * 0.18);
    for (let i = 0; i < digits; i++) {
      const d = v[i];
      out[i][d] = (out[i][d] || 0) + w;
    }
  });

  return out;
};

AnalysisEngine.pairProfile = function(values, digits) {
  const out = {};

  values.forEach((v, idx) => {
    const w = 1 / (1 + idx * 0.18);
    for (let i = 0; i < digits - 1; i++) {
      const pair = v.slice(i, i + 2);
      out[pair] = (out[pair] || 0) + w;
    }
  });

  return out;
};

AnalysisEngine.gapScore = function(num, historyValues) {
  const idx = historyValues.indexOf(num);

  if (idx === 0) return -5.5;
  if (idx === 1) return -3.0;
  if (idx === 2) return -1.6;
  if (idx >= 3 && idx <= 8) return 0.25;
  if (idx >= 9 && idx <= 20) return 1.0;
  if (idx >= 21 && idx <= 40) return 0.72;
  if (idx === -1) return 0.48;

  return 0.36;
};

AnalysisEngine.novelty = function(num, historyValues) {
  const short = historyValues.slice(0, 12);
  const long = historyValues.slice(0, 60);

  const shortSet = new Set(short);
  const longSet = new Set(long);

  let score = 0;

  if (!shortSet.has(num) && longSet.has(num)) score += 0.9;
  if (!longSet.has(num)) score += 0.35;

  const unique = new Set(num.split("")).size;
  if (num.length === 2) {
    if (unique === 2) score += 0.45;
    else score -= 0.12;
  } else {
    if (unique === 3) score += 0.6;
    else if (unique === 2) score += 0.15;
    else score -= 0.35;
  }

  const mirror = num.split("").reverse().join("");
  if (mirror !== num && shortSet.has(mirror)) score += 0.28;

  return score;
};

AnalysisEngine.runBacktest = function(data, rounds = 20) {
  const clean = this.prepare(data);
  const limit = Math.min(rounds, clean.length - 1);

  const strict = { last2: 0, top3: 0, bottom3: 0 };
  const practical = { last2: 0, top3: 0, bottom3: 0 };
  const rows = [];

  for (let i = 0; i < limit; i++) {
    const settled = clean[i];
    const history = clean.slice(i + 1);

    if (history.length < this.CONFIG.minHistory) continue;

    const regime = this.detectRegime(history);

    const top2 = this.top(this.scoreAll(
      this.gen2(),
      settled.last2,
      history.map(x => x.last2),
      regime,
      2
    ));

    const top3 = this.top(this.scoreAll(
      this.gen3(),
      settled.top3,
      history.map(x => x.top3),
      regime,
      3
    ));

    const bottom3 = this.top(this.scoreAll(
      this.gen3(),
      settled.bottom3[0],
      history.flatMap(x => x.bottom3),
      regime,
      3
    ));

    const strictLast2 = top2.slice(0, 5).some(x => x.num === settled.last2);
const strictTop3 = top3.slice(0, 5).some(x => x.num === settled.top3);
const strictBottom3 = bottom3.slice(0, 5).some(x => settled.bottom3.includes(x.num));

const practicalLast2 = top2.slice(0, 10).some(x => x.num === settled.last2);
const practicalTop3 = top3.slice(0, 10).some(x => x.num === settled.top3);
const practicalBottom3 = bottom3.slice(0, 10).some(x => settled.bottom3.includes(x.num));

    if (strictLast2) strict.last2++;
    if (strictTop3) strict.top3++;
    if (strictBottom3) strict.bottom3++;

    if (practicalLast2) practical.last2++;
    if (practicalTop3) practical.top3++;
    if (practicalBottom3) practical.bottom3++;

    rows.push({
      date: settled.date,
      settled,
      top2,
      top3,
      bottom3,
      strictLast2,
      strictTop3,
      strictBottom3,
      practicalLast2,
      practicalTop3,
      practicalBottom3
    });
  }

  const count = rows.length || 1;

  return {
    count,
    rows,
    strictRate: {
      last2: Number(((strict.last2 / count) * 100).toFixed(2)),
      top3: Number(((strict.top3 / count) * 100).toFixed(2)),
      bottom3: Number(((strict.bottom3 / count) * 100).toFixed(2))
    },
    practicalRate: {
      last2: Number(((practical.last2 / count) * 100).toFixed(2)),
      top3: Number(((practical.top3 / count) * 100).toFixed(2)),
      bottom3: Number(((practical.bottom3 / count) * 100).toFixed(2))
    }
  };
};
AnalysisEngine.inspectLatest = function(data) {
  const clean = this.prepare(data);
  const latest = clean[0];
  const previous = clean[1] || null;

  return {
    latest,
    previous,
    top3Consistent: latest ? latest.top3 === latest.firstPrize.slice(-3) : false
  };
};

AnalysisEngine.runFromUrl = async function(url = "data.json") {
  const res = await fetch(`${url}?v=${Date.now()}`);
  if (!res.ok) {
    throw new Error(`โหลดไฟล์ไม่สำเร็จ: ${url}`);
  }

  const raw = await res.json();
  const result = this.run(raw);
  const backtest = this.runBacktest(raw, this.CONFIG.backtestRounds);

  const latest = result.latest;
  const forecastNow = result.forecastNow;

  const lastSettledHistory = this.prepare(raw).slice(1);
  const lastSettledRegime = this.detectRegime(lastSettledHistory);

  const lastSettledForecast = {
    last2: this.top(this.scoreAll(
      this.gen2(),
      latest.last2,
      lastSettledHistory.map(x => x.last2),
      lastSettledRegime,
      2
    )),
    top3: this.top(this.scoreAll(
      this.gen3(),
      latest.top3,
      lastSettledHistory.map(x => x.top3),
      lastSettledRegime,
      3
    )),
    bottom3: this.top(this.scoreAll(
      this.gen3(),
      latest.bottom3[0],
      lastSettledHistory.flatMap(x => x.bottom3),
      lastSettledRegime,
      3
    ))
  };

  lastSettledForecast.hybrid = this.buildHybrid(
    lastSettledForecast.top3,
    lastSettledForecast.bottom3
  );

  const nearTop3 = this.findNearMatches(lastSettledForecast.top3, [latest.top3]);
  const nearBottom3 = this.findNearMatches(lastSettledForecast.bottom3, latest.bottom3);

  return {
    data: this.prepare(raw),
    latest,
    regime: result.regime,
    forecastNow,
    lastSettledForecast,
    backtest,
    nearMatches: {
      top3: nearTop3,
      bottom3: nearBottom3
    }
  };
};

AnalysisEngine.findNearMatches = function(list, actualSet) {
  const hits = [];

  list.forEach(item => {
    actualSet.forEach(real => {
      let samePos = 0;
      for (let i = 0; i < item.num.length; i++) {
        if (item.num[i] === real[i]) samePos++;
      }

      const pool = real.split("");
      let sameDigits = 0;
      item.num.split("").forEach(d => {
        const idx = pool.indexOf(d);
        if (idx !== -1) {
          sameDigits++;
          pool.splice(idx, 1);
        }
      });

      if (samePos >= item.num.length - 1 || sameDigits >= item.num.length - 1) {
        hits.push({
          forecast: item.num,
          actual: real,
          samePos,
          sameDigits
        });
      }
    });
  });

  return hits.slice(0, 8);
};

AnalysisEngine.summarize = function(result) {
  return {
    latestDate: result.latest.date,
    latestFirstPrize: result.latest.firstPrize,
    latestTop3: result.latest.top3,
    latestLast2: result.latest.last2,
    forecastNow: {
      last2: result.forecastNow.last2.map(x => x.num),
      top3: result.forecastNow.top3.map(x => x.num),
      bottom3: result.forecastNow.bottom3.map(x => x.num),
      hybrid: result.forecastNow.hybrid.map(x => x.num)
    },
    backtest: result.backtest
  };
};
