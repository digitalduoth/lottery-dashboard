export const AnalysisEngine = (() => {
  const CONFIG = {
    backtestRounds: 24,
    minHistory: 12,
    forecastTake: 10,

    weights: {
      transition: 0.24,
      position: 0.18,
      pair: 0.14,
      gap: 0.16,
      cycle: 0.10,
      diversity: 0.08,
      coldHotBalance: 0.10
    },

    penalties: {
      exactRepeat: 3.4,
      samePositionAll: 2.2,
      samePositionAlmost: 1.15,
      sameDigitsAll: 1.0,
      hotRepeatScale: 0.42,
      recentSeenScale: 0.72
    }
  };

  function sortDescByDate(data) {
    return [...data].sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function validateRow(row) {
    return !!(
      row &&
      typeof row.date === "string" &&
      typeof row.firstPrize === "string" &&
      typeof row.top3 === "string" &&
      typeof row.last2 === "string" &&
      Array.isArray(row.front3) &&
      Array.isArray(row.bottom3)
    );
  }

  function normalizeData(data) {
    const clean = data
      .filter(validateRow)
      .map((row) => ({
        date: row.date,
        firstPrize: String(row.firstPrize).padStart(6, "0"),
        top3: String(row.top3).padStart(3, "0"),
        last2: String(row.last2).padStart(2, "0"),
        front3: row.front3.map((x) => String(x).padStart(3, "0")).slice(0, 2),
        bottom3: row.bottom3.map((x) => String(x).padStart(3, "0")).slice(0, 2)
      }));

    return sortDescByDate(clean);
  }

  function weightByAge(index) {
    return Math.exp(-index / 14);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  function std(values) {
    if (values.length < 2) return 0;
    const avg = mean(values);
    const variance = mean(values.map((v) => (v - avg) ** 2));
    return Math.sqrt(variance);
  }

  function buildDigitPositionCounts(values) {
    const len = values[0].length;
    const counts = Array.from({ length: len }, () => ({}));

    values.forEach((value, index) => {
      const w = weightByAge(index);
      value.split("").forEach((digit, pos) => {
        counts[pos][digit] = (counts[pos][digit] || 0) + w;
      });
    });

    return counts;
  }

  function buildTransitionCounts(values) {
    const len = values[0].length;
    const transitions = Array.from({ length: len }, () => ({}));

    for (let i = 1; i < values.length; i++) {
      const newer = values[i - 1];
      const older = values[i];
      const w = weightByAge(i);

      for (let pos = 0; pos < len; pos++) {
        const key = `${older[pos]}->${newer[pos]}`;
        transitions[pos][key] = (transitions[pos][key] || 0) + w;
      }
    }

    return transitions;
  }

  function buildPairCounts(values) {
    const len = values[0].length;
    const pairs = {};

    values.forEach((value, index) => {
      const w = weightByAge(index);
      for (let pos = 0; pos < len - 1; pos++) {
        const key = value.slice(pos, pos + 2);
        pairs[key] = (pairs[key] || 0) + w;
      }
    });

    return pairs;
  }

  function buildExactCounts(values) {
    const exact = {};
    values.forEach((value, index) => {
      exact[value] = (exact[value] || 0) + weightByAge(index);
    });
    return exact;
  }

  function buildGapMap(values) {
    const gapMap = {};
    values.forEach((value, index) => {
      if (gapMap[value] === undefined) gapMap[value] = index;
    });
    return gapMap;
  }

  function buildCycleProfile(values) {
    const positions = {};
    values.forEach((value, index) => {
      if (!positions[value]) positions[value] = [];
      positions[value].push(index);
    });

    const cycle = {};
    Object.entries(positions).forEach(([num, idxs]) => {
      if (idxs.length < 2) {
        cycle[num] = { meanGap: null, stdGap: null };
        return;
      }
      const gaps = [];
      for (let i = 1; i < idxs.length; i++) {
        gaps.push(idxs[i] - idxs[i - 1]);
      }
      cycle[num] = {
        meanGap: mean(gaps),
        stdGap: std(gaps)
      };
    });

    return cycle;
  }
    function similarityToRecent(num, recent) {
    let samePos = 0;
    for (let i = 0; i < num.length; i++) {
      if (num[i] === recent[i]) samePos++;
    }

    let sameDigits = 0;
    const pool = recent.split("");
    for (const d of num.split("")) {
      const idx = pool.indexOf(d);
      if (idx !== -1) {
        sameDigits++;
        pool.splice(idx, 1);
      }
    }

    return { samePos, sameDigits };
  }

  function diversityScore(num) {
    const unique = new Set(num.split("")).size;

    if (num.length === 2) {
      if (unique === 2) return 1.0;
      return 0.76;
    }

    if (unique === 3) return 1.0;
    if (unique === 2) return 0.83;
    return 0.58;
  }

  function gapReturnScore(num, gapMap) {
    const gap = gapMap[num] !== undefined ? gapMap[num] : 999;

    if (gap >= 3 && gap <= 10) return 1.0;
    if (gap >= 11 && gap <= 20) return 0.78;
    if (gap >= 21 && gap <= 40) return 0.55;
    if (gap <= 2) return 0.18;
    return 0.42;
  }

  function cycleScore(num, values, cycleProfile) {
    const info = cycleProfile[num];
    if (!info || info.meanGap == null) return 0.44;

    const seenAt = values.indexOf(num);
    const currentGap = seenAt === -1 ? values.length + 1 : seenAt;

    const distance = Math.abs(currentGap - info.meanGap);
    const spread = Math.max(info.stdGap || 1, 1.5);

    return Math.exp(-(distance ** 2) / (2 * spread ** 2));
  }

  function coldHotBalanceScore(num, exactCounts, values) {
    const hot = exactCounts[num] || 0;
    const maxHot = Math.max(...Object.values(exactCounts), 0.0001);
    const normalizedHot = hot / maxHot;

    if (normalizedHot <= 0.18) return 0.82;
    if (normalizedHot <= 0.38) return 1.0;
    if (normalizedHot <= 0.58) return 0.86;
    return 0.52;
  }

  function transitionScore(num, latestValue, transitionCounts) {
    let score = 0;
    for (let pos = 0; pos < num.length; pos++) {
      const key = `${latestValue[pos]}->${num[pos]}`;
      score += transitionCounts[pos][key] || 0;
    }
    return score;
  }

  function positionScore(num, positionCounts) {
    let score = 0;
    for (let pos = 0; pos < num.length; pos++) {
      score += positionCounts[pos][num[pos]] || 0;
    }
    return score;
  }

  function pairScore(num, pairCounts) {
    let score = 0;
    for (let pos = 0; pos < num.length - 1; pos++) {
      score += pairCounts[num.slice(pos, pos + 2)] || 0;
    }
    return score;
  }

  function recentSeenPenalty(num, values) {
    const idx = values.indexOf(num);
    if (idx === -1) return 0;
    if (idx === 0) return CONFIG.penalties.exactRepeat;
    if (idx === 1) return CONFIG.penalties.recentSeenScale * 1.2;
    if (idx === 2) return CONFIG.penalties.recentSeenScale;
    if (idx <= 4) return CONFIG.penalties.recentSeenScale * 0.7;
    return 0;
  }

  function overlapPenalty(num, latestValue) {
    const sim = similarityToRecent(num, latestValue);
    let penalty = 0;

    if (num === latestValue) {
      penalty += CONFIG.penalties.exactRepeat;
    }

    if (sim.samePos === num.length) {
      penalty += CONFIG.penalties.samePositionAll;
    } else if (sim.samePos === num.length - 1) {
      penalty += CONFIG.penalties.samePositionAlmost;
    }

    if (sim.sameDigits === num.length) {
      penalty += CONFIG.penalties.sameDigitsAll;
    }

    return penalty;
  }

  function scoreCandidate(num, values, stats) {
    const latestValue = values[0];

    const t = transitionScore(num, latestValue, stats.transitionCounts);
    const p = positionScore(num, stats.positionCounts);
    const pair = pairScore(num, stats.pairCounts);
    const gap = gapReturnScore(num, stats.gapMap);
    const cycle = cycleScore(num, values, stats.cycleProfile);
    const diversity = diversityScore(num);
    const coldHot = coldHotBalanceScore(num, stats.exactCounts, values);

    const raw =
      (t * CONFIG.weights.transition) +
      (p * CONFIG.weights.position) +
      (pair * CONFIG.weights.pair) +
      (gap * CONFIG.weights.gap) +
      (cycle * CONFIG.weights.cycle) +
      (diversity * CONFIG.weights.diversity) +
      (coldHot * CONFIG.weights.coldHotBalance);

    const hotPenalty = (stats.exactCounts[num] || 0) * CONFIG.penalties.hotRepeatScale;
    const recentPenalty = recentSeenPenalty(num, values);
    const overlap = overlapPenalty(num, latestValue);

    return raw - hotPenalty - recentPenalty - overlap;
  }

  function buildStats(values) {
    return {
      positionCounts: buildDigitPositionCounts(values),
      transitionCounts: buildTransitionCounts(values),
      pairCounts: buildPairCounts(values),
      exactCounts: buildExactCounts(values),
      gapMap: buildGapMap(values),
      cycleProfile: buildCycleProfile(values)
    };
  }

  function generateAll2Digits() {
    const out = [];
    for (let a = 0; a <= 9; a++) {
      for (let b = 0; b <= 9; b++) {
        out.push(`${a}${b}`);
      }
    }
    return out;
  }

  function generateAll3Digits() {
    const out = [];
    for (let a = 0; a <= 9; a++) {
      for (let b = 0; b <= 9; b++) {
        for (let c = 0; c <= 9; c++) {
          out.push(`${a}${b}${c}`);
        }
      }
    }
    return out;
  }

  function normalizeForecast(scored, take = CONFIG.forecastTake) {
    const top = scored.slice(0, take);
    const max = top[0]?.score ?? 1;
    const min = top[top.length - 1]?.score ?? 0;
    const span = Math.max(max - min, 0.000001);

    return top.map((item) => ({
      num: item.num,
      score: item.score,
      percent: Number((42 + ((item.score - min) / span) * 58).toFixed(2))
    }));
  }

  function rankValues(values, digitLength) {
    const stats = buildStats(values);
    const candidates = digitLength === 2 ? generateAll2Digits() : generateAll3Digits();

    const scored = candidates.map((num) => ({
      num,
      score: scoreCandidate(num, values, stats)
    }));

    scored.sort((a, b) => b.score - a.score);
    return normalizeForecast(scored);
  }
    function buildLast2Forecast(history) {
    const values = history.map((r) => r.last2);
    return rankValues(values, 2);
  }

  function buildTop3Forecast(history) {
    const values = history.map((r) => r.top3);
    return rankValues(values, 3);
  }

  function buildBottom3Forecast(history) {
    const values = history.flatMap((r) => r.bottom3);
    return rankValues(values, 3);
  }

  function buildHybridForecast(top3, bottom3) {
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

    return ranked.slice(0, CONFIG.forecastTake).map((item) => ({
      num: item.num,
      score: item.score,
      percent: Number((42 + ((item.score - min) / span) * 58).toFixed(2))
    }));
  }

  function buildForecast(history) {
    if (!history || history.length < CONFIG.minHistory) {
      throw new Error("ข้อมูลย้อนหลังไม่พอสำหรับสร้าง forecast");
    }

    const last2 = buildLast2Forecast(history);
    const top3 = buildTop3Forecast(history);
    const bottom3 = buildBottom3Forecast(history);
    const hybrid = buildHybridForecast(top3, bottom3);

    return { last2, top3, bottom3, hybrid };
  }

  function checkHit(list, actual, topN = 5) {
    const nums = list.slice(0, topN).map((x) => x.num);
    if (Array.isArray(actual)) {
      return actual.some((x) => nums.includes(x));
    }
    return nums.includes(actual);
  }

  function nearMatch3(list, actualSet) {
    const hits = [];

    list.forEach((item) => {
      actualSet.forEach((real) => {
        let samePos = 0;
        for (let i = 0; i < 3; i++) {
          if (item.num[i] === real[i]) samePos++;
        }

        let sameDigits = 0;
        const pool = real.split("");
        item.num.split("").forEach((d) => {
          const idx = pool.indexOf(d);
          if (idx !== -1) {
            sameDigits++;
            pool.splice(idx, 1);
          }
        });

        if (samePos >= 2 || sameDigits >= 2) {
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
  }

  function runBacktest(data, rounds = CONFIG.backtestRounds) {
    const limit = Math.min(rounds, data.length - 1);
    const rows = [];

    const strictHit = { last2: 0, top3: 0, bottom3: 0 };
    const practicalHit = { last2: 0, top3: 0, bottom3: 0 };

    for (let i = 0; i < limit; i++) {
      const settled = data[i];
      const history = data.slice(i + 1);

      if (history.length < CONFIG.minHistory) continue;

      const forecast = buildForecast(history);

      const strictLast2 = checkHit(forecast.last2, settled.last2, 5);
      const strictTop3 = checkHit(forecast.top3, settled.top3, 5);
      const strictBottom3 = checkHit(forecast.bottom3, settled.bottom3, 5);

      const practicalLast2 = checkHit(forecast.last2, settled.last2, 10);
      const practicalTop3 = checkHit(forecast.top3, settled.top3, 10);
      const practicalBottom3 = checkHit(forecast.bottom3, settled.bottom3, 10);

      if (strictLast2) strictHit.last2++;
      if (strictTop3) strictHit.top3++;
      if (strictBottom3) strictHit.bottom3++;

      if (practicalLast2) practicalHit.last2++;
      if (practicalTop3) practicalHit.top3++;
      if (practicalBottom3) practicalHit.bottom3++;

      rows.push({
        date: settled.date,
        settled,
        forecast,
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
        last2: Number(((strictHit.last2 / count) * 100).toFixed(2)),
        top3: Number(((strictHit.top3 / count) * 100).toFixed(2)),
        bottom3: Number(((strictHit.bottom3 / count) * 100).toFixed(2))
      },
      practicalRate: {
        last2: Number(((practicalHit.last2 / count) * 100).toFixed(2)),
        top3: Number(((practicalHit.top3 / count) * 100).toFixed(2)),
        bottom3: Number(((practicalHit.bottom3 / count) * 100).toFixed(2))
      }
    };
  }

  function buildEngineOutput(rawData) {
    const data = normalizeData(rawData);
    if (data.length < CONFIG.minHistory + 1) {
      throw new Error("ข้อมูลใน data.json ยังน้อยเกินไป");
    }

    const settled = data[0];
    const forecastNow = buildForecast(data);
    const lastSettledForecast = buildForecast(data.slice(1));
    const backtest = runBacktest(data, CONFIG.backtestRounds);

    const nearTop = nearMatch3(lastSettledForecast.top3, [settled.top3]);
    const nearBottom = nearMatch3(lastSettledForecast.bottom3, settled.bottom3);

    return {
      config: CONFIG,
      data,
      settled,
      forecastNow,
      lastSettledForecast,
      backtest,
      nearMatches: {
        top3: nearTop,
        bottom3: nearBottom
      }
    };
  }
    function formatTopNumbers(list, take = 6) {
    return list.slice(0, take).map((x) => x.num);
  }

  function summarizeEngineOutput(result) {
    return {
      latestDate: result.settled.date,
      latestFirstPrize: result.settled.firstPrize,
      latestTop3: result.settled.top3,
      latestLast2: result.settled.last2,
      latestFront3: [...result.settled.front3],
      latestBottom3: [...result.settled.bottom3],

      forecastNow: {
        last2: formatTopNumbers(result.forecastNow.last2, 10),
        top3: formatTopNumbers(result.forecastNow.top3, 10),
        bottom3: formatTopNumbers(result.forecastNow.bottom3, 10),
        hybrid: formatTopNumbers(result.forecastNow.hybrid, 10)
      },

      lastSettledCheck: {
        last2: result.lastSettledForecast.last2.slice(0, 10),
        top3: result.lastSettledForecast.top3.slice(0, 10),
        bottom3: result.lastSettledForecast.bottom3.slice(0, 10),
        hybrid: result.lastSettledForecast.hybrid.slice(0, 10),

        hitStrict: {
          last2: checkHit(result.lastSettledForecast.last2, result.settled.last2, 5),
          top3: checkHit(result.lastSettledForecast.top3, result.settled.top3, 5),
          bottom3: checkHit(result.lastSettledForecast.bottom3, result.settled.bottom3, 5)
        },

        hitPractical: {
          last2: checkHit(result.lastSettledForecast.last2, result.settled.last2, 10),
          top3: checkHit(result.lastSettledForecast.top3, result.settled.top3, 10),
          bottom3: checkHit(result.lastSettledForecast.bottom3, result.settled.bottom3, 10)
        }
      },

      backtest: result.backtest,
      nearMatches: result.nearMatches
    };
  }

  async function loadFromUrl(url = "data.json") {
    const res = await fetch(`${url}?v=${Date.now()}`);
    if (!res.ok) {
      throw new Error(`โหลดไฟล์ไม่สำเร็จ: ${url}`);
    }

    const raw = await res.json();
    return normalizeData(raw);
  }

  async function runFromUrl(url = "data.json") {
    const data = await loadFromUrl(url);
    return buildEngineOutput(data);
  }

  function inspectLatest(rawData) {
    const data = normalizeData(rawData);
    const settled = data[0];
    const previous = data[1] || null;

    return {
      latest: settled,
      previous,
      latestTop3FromFirstPrize: settled ? settled.firstPrize.slice(-3) : null,
      top3Consistent: settled ? settled.top3 === settled.firstPrize.slice(-3) : false
    };
  }

  function createPublicApi() {
    return {
      config: CONFIG,

      normalizeData,
      buildForecast,
      buildEngineOutput,
      runBacktest,
      nearMatch3,
      inspectLatest,
      summarizeEngineOutput,
      loadFromUrl,
      runFromUrl
    };
  }

  return createPublicApi();
})();
