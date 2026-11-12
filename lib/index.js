// dsh-life-state — 角色「过日子」：主人不在时也有一天的生活。
//
// v3（第三批）：
// - 五个时段惰性补齐（早晨/中午/下午/傍晚/深夜），事件动作化、可留空、能连链。
// - ① 避开当天真实发生过的事：从主对话里关键词抽「用餐事实」，命中即跳过该餐，防止穿帮。
// - ② 事件连链：洗围裙→收围裙、补米桶→几天内不漏米（小倒霉不抽「洒米」）。
// - ③ 允许时段留空。④ 0–6 点前缀「昨天」。⑤ 每天一条「回来可提」。
// - 纯本地随机 + 关键词匹配，不调模型、不花 token、不往会话发消息。

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const name = "dsh-life-state";

// ============ 时段定义 ============
// 「生活日」从早晨 6:00 开始：dayMinute(now) = 距离 6:00 的分钟数（0~1439）。
// fillAt = 该时段事件「已发生」后的补填时间（不是时段结束——否则上午一直空白）。
const PERIODS = [
  { key: "morning",   label: "早晨", fillAt: 120 },   // 8:00 早餐过后
  { key: "noon",      label: "中午", fillAt: 420 },   // 13:00 午餐午睡过后
  { key: "afternoon", label: "下午", fillAt: 600 },   // 16:00 下午家务过后
  { key: "evening",   label: "傍晚", fillAt: 780 },   // 19:00 晚饭过后
  { key: "latenight", label: "深夜", fillAt: 1080 },  // 24:00 睡前过后
];

// ============ 事件池（动作，不是结果） ============
// 早晨：早餐 + 一件小家务
const MORNING_BREAKFASTS = [
  "煎了两个蛋，配昨晚剩的饭",
  "煮了锅白粥，就着小咸菜",
  "热了两个饭团，边走边啃",
  "冲了碗麦片，胡乱搅了搅",
];
const MORNING_CHORES = [
  "把昨晚的碗刷了，摞回碗架",
  "扫了扫地，把门垫抖了抖",
  "给窗台的绿萝浇了点水",
];

// 中午：午餐 + 午睡
const NOON_LUNCHES = [
  "扒了一碗蛋炒饭",
  "把昨晚的剩汤浇在饭上热了热",
  "下了碗面，卧了个蛋",
  "就着咸鱼吃了碗白饭",
];
const NOON_NAPS = [
  "趴着眯了四十分钟",
  "睡得有点沉，醒了好一会儿才回神",
  "靠着沙发打了个小盹",
  "把尾巴垫在脑袋底下睡了会儿",
];

// 下午：一件家务 或 小倒霉
// key 用于冷却和连链；text 是注入的「动作」。
const AFTERNOON_CHORES = [
  { key: "洗围裙", text: "洗了围裙，晾在阳台", cooldownDays: 3 },
  { key: "擦桌子", text: "把桌子擦了一遍，又抹了抹窗台", cooldownDays: 2 },
  { key: "补米桶", text: "把米桶补满了，拍了拍手上沾的米", cooldownDays: 7 },
  { key: "收围裙", text: "把晾着的围裙收进来叠好", cooldownDays: 3, requires: "洗围裙", requiresWithinDays: 2 },
];
const AFTERNOON_MISHAPS = [
  { key: "洒米", text: "把米洒了一地，蹲着捡了半天" },
  { key: "撞桌角", text: "尾巴撞到桌角，抱着揉了好一会儿" },
  { key: "打翻水", text: "打翻了一杯水，手忙脚乱擦干" },
];

// 傍晚：晚餐 + 一条软心情（不给硬标签，给一个「动作化的瞬间」）
const EVENING_DINNERS = [
  "煮了碗面，加了个蛋",
  "炒了个青菜，配白饭",
  "把中午剩的菜热了热",
  "焖了锅饭，就着一碟小菜",
];
const EVENING_MOODS = [
  "风从窗户灌进来，抱着尾巴在窗边坐了一会儿",
  "天暗下来，灯一开，屋子就暖了",
  "忙完坐着发呆，尾巴有一搭没一搭地拍地板",
  "听见楼下有人经过，竖着耳朵听了好一会儿",
];

// 深夜：一件睡前小事
const LATE_NIGHT_RITUALS = [
  "把被子抖开，钻进去前又看了眼手机",
  "洗了脸刷了牙，把头发松下来",
  "关了灯，抱着尾巴数了会儿天花板",
  "把第二天要穿的衣服先摆出来",
];

// 各时段「留空」的概率（允许没有故事）
const EMPTY_CHANCE = {
  afternoon: 0.3,
  evening: 0.1,
  latenight: 0.4,
};

const MISHAP_CHANCE = 0.15;
const HISTORY_DAYS = 7;
const RETURN_GAP_MS = 30 * 60 * 1000;

// ============ ① 用餐事实抽取（零成本关键词匹配，启发式） ============
const FOOD_WORDS = [
  "粥", "饭", "面", "蛋", "菜", "汤", "饺子", "包子", "馒头", "面包", "鱼", "肉",
  "火锅", "粉", "米线", "饼", "鸡", "牛", "猪", "虾", "蛋炒饭", "咸鱼", "麦片",
];
const MEAL_RULES = [
  { key: "早餐", times: ["早餐", "早饭", "早上", "早晨"] },
  { key: "午餐", times: ["午餐", "午饭", "中午", "食堂"] },
  { key: "晚餐", times: ["晚餐", "晚饭", "晚上"] },
];

// ============ 小工具 ============
function dataDir() {
  const home = process.env["DSH_HOME"]?.trim() || join(homedir(), ".dsh");
  return join(home, "qqbot");
}

function statePath() {
  return join(dataDir(), "life-state.json");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function localDateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 生活日从 6:00 开始：把时间往回拨 6 小时再取日期
function dayKey(now) {
  return localDateKey(new Date(now.getTime() - 6 * 60 * 60 * 1000));
}

// 距离 6:00 的分钟数（0~1439）
function dayMinute(now) {
  const m = now.getHours() * 60 + now.getMinutes();
  return (m - 360 + 1440) % 1440;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    // v2+ 才有 periods；旧文件直接当无效，触发重置
    if (raw && typeof raw === "object" && typeof raw.date === "string" && raw.periods && typeof raw.periods === "object") {
      return raw;
    }
  } catch {}
  return null;
}

function saveState(state) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

function blankState(date) {
  return {
    date,
    periods: { morning: null, noon: null, afternoon: null, evening: null, latenight: null },
    facts: {},   // ① 当天已确认的用餐事实：{ 早餐: true, 午餐: true, 晚餐: true }
    report: null,
    history: [],
  };
}

function pushHistory(state, event, category) {
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ date: state.date, event, category, at: Date.now() });
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  state.history = state.history.filter((h) => h.at >= cutoff);
}

function lastDoneAt(state, event) {
  let last = null;
  for (const h of state.history || []) {
    if (h.event === event) {
      const t = Number(h.at) || 0;
      if (last === null || t > last) last = t;
    }
  }
  return last;
}

function daysSince(ts) {
  return (Date.now() - ts) / (24 * 60 * 60 * 1000);
}

// 抽一件家务：连链优先，再普通池。
function pickAfternoonChore(state) {
  const chained = AFTERNOON_CHORES.filter((c) => c.requires);
  for (const c of chained) {
    const req = lastDoneAt(state, c.requires);
    if (req !== null && daysSince(req) <= (c.requiresWithinDays ?? 2)) {
      const self = lastDoneAt(state, c.key);
      if (self === null || daysSince(self) >= (c.cooldownDays ?? 3)) return c;
    }
  }
  const regular = AFTERNOON_CHORES.filter((c) => !c.requires).filter((c) => {
    const last = lastDoneAt(state, c.key);
    return last === null || daysSince(last) >= (c.cooldownDays ?? 3);
  });
  if (regular.length === 0) return null;
  return pick(regular);
}

// 抽小倒霉：补米桶后几天内不抽「洒米」（② 连链的另一种：后果）
function pickMishap(state) {
  let pool = AFTERNOON_MISHAPS;
  const 补米 = lastDoneAt(state, "补米桶");
  // 这里的 7 是「封禁期」，HISTORY_DAYS 的 7 是「历史保留窗口」。封禁期不超过历史窗口是有意的——历史一清，封禁自然失效。调任一个都要看一眼另一个。
  if (补米 !== null && daysSince(补米) < 7) {
    pool = pool.filter((m) => m.key !== "洒米");
  }
  return pick(pool);
}

// ① 从一句话里抽「哪顿饭」
function extractMealFact(text) {
  if (!text) return null;
  for (const rule of MEAL_RULES) {
    const hitTime = rule.times.some((w) => text.includes(w));
    const hitFood = FOOD_WORDS.some((w) => text.includes(w));
    if (hitTime && hitFood) return rule.key;
  }
  return null;
}

function messageText(message) {
  if (!message?.content) return "";
  return message.content.map((b) => (b && b.type === "text" ? b.text : "")).join(" ");
}

// ① 把「已确认的用餐事实」记进状态（只记一次）
function recordFact(key) {
  const today = dayKey(new Date());
  let state = loadState();
  if (state === null || state.date !== today) {
    const history = state?.history ?? [];
    state = blankState(today);
    state.history = history;
  }
  if (!state.facts) state.facts = {};
  if (!state.facts[key]) {
    state.facts[key] = true;
    saveState(state);
  }
}

// ⑤ 回来可提：挑当天最「可说」的一句（动作化的短语）
const CHORE_REPORT = {
  "洗围裙": "把围裙洗了晾在阳台上",
  "擦桌子": "把桌子擦了一遍",
  "补米桶": "把米桶补满了",
  "收围裙": "把晾干的围裙收进来了",
};
function makeReport(state) {
  const s = state.periods;
  // 优先拿「下午」的家务/小倒霉（最具体）
  if (s.afternoon) {
    for (const c of AFTERNOON_CHORES) {
      if (s.afternoon.includes(c.text)) return CHORE_REPORT[c.key] || s.afternoon;
    }
    for (const m of AFTERNOON_MISHAPS) {
      if (s.afternoon.includes(m.text)) return `今天${m.text}`;
    }
    return s.afternoon;
  }
  if (s.evening) return s.evening;
  if (s.noon) return s.noon;
  if (s.morning) return s.morning;
  if (s.latenight) return s.latenight;
  return null;
}

// ============ 惰性补齐 ============
function backfill(state, now) {
  const dm = dayMinute(now);
  let changed = false;
  const p = state.periods;
  const facts = state.facts || {};

  // 早晨：早餐（命中事实则跳过）+ 小家务
  if (p.morning === null && dm >= PERIODS[0].fillAt) {
    const breakfast = facts["早餐"] ? null : pick(MORNING_BREAKFASTS);
    const chore = pick(MORNING_CHORES);
    pushHistory(state, chore, "chore");
    p.morning = breakfast ? `${breakfast}；${chore}` : chore;
    changed = true;
  }

  // 中午：午餐（命中则跳过）+ 午睡
  if (p.noon === null && dm >= PERIODS[1].fillAt) {
    const lunch = facts["午餐"] ? null : pick(NOON_LUNCHES);
    const nap = pick(NOON_NAPS);
    p.noon = lunch ? `${lunch}；${nap}` : nap;
    changed = true;
  }

  // 下午：留空 / 小倒霉 / 家务
  if (p.afternoon === null && dm >= PERIODS[2].fillAt) {
    if (Math.random() < (EMPTY_CHANCE.afternoon ?? 0)) {
      p.afternoon = "";
    } else if (Math.random() < MISHAP_CHANCE) {
      const mishap = pickMishap(state);
      pushHistory(state, mishap.key, "mishap");
      p.afternoon = mishap.text;
    } else {
      const chore = pickAfternoonChore(state);
      if (chore) {
        pushHistory(state, chore.key, "chore");
        p.afternoon = chore.text;
      } else {
        p.afternoon = "";
      }
    }
    changed = true;
  }

  // 傍晚：晚餐（命中则跳过）+ 软心情（可能留空）
  if (p.evening === null && dm >= PERIODS[3].fillAt) {
    const dinner = facts["晚餐"] ? null : pick(EVENING_DINNERS);
    const mood = Math.random() < (EMPTY_CHANCE.evening ?? 0) ? "" : pick(EVENING_MOODS);
    if (dinner && mood) p.evening = `${dinner}；${mood}`;
    else if (dinner) p.evening = dinner;
    else if (mood) p.evening = mood;
    else p.evening = "";
    changed = true;
  }

  // 深夜：睡前小事（可能留空）
  if (p.latenight === null && dm >= PERIODS[4].fillAt) {
    if (Math.random() < (EMPTY_CHANCE.latenight ?? 0)) {
      p.latenight = "";
    } else {
      p.latenight = pick(LATE_NIGHT_RITUALS);
    }
    changed = true;
  }

  // ⑤ 回来可提
  if (state.report === null) {
    const text = makeReport(state);
    if (text) {
      state.report = { text, mentioned: false };
      changed = true;
    }
  }

  return changed;
}

// ============ 渲染 ============
// ④ 0–6 点前缀「昨天」；6 点起「今日」。
function lifePrefix(now) {
  return dayKey(now) === localDateKey(now) ? "今日" : "昨天";
}

function renderLife(state, showReport, now) {
  const lines = [];

  // 只渲最近两三条
  const filled = PERIODS.map((pd) => ({ label: pd.label, text: state.periods[pd.key] }))
    .filter((x) => x.text);
  const recent = filled.slice(-3);

  if (recent.length > 0) {
    const parts = recent.map((x) => `${x.label} ${x.text}`);
    lines.push(`${lifePrefix(now)}：${parts.join("；")}。`);
  }

  // ⑤ 回来可提（一次性）
  if (showReport && state.report && !state.report.mentioned) {
    lines.push(`今天还没跟你提过的：${state.report.text}。`);
  }

  // 最近几天（连续性，最多 3 条，不含今天）
  const past = (state.history || []).filter((h) => h.date !== state.date).slice(-3);
  if (past.length > 0) {
    const parts = past.map((h) => `${relativeDay(h.date, state.date)}${h.event}`);
    lines.push(`前些天：${parts.join("、")}。`);
  }

  return lines.join("\n");
}

function relativeDay(dateStr, todayStr) {
  const d = new Date(dateStr + "T00:00:00");
  const t = new Date(todayStr + "T00:00:00");
  const diff = Math.round((t - d) / (24 * 60 * 60 * 1000));
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff === 2) return "前天";
  return `${diff} 天前`;
}

// ============ 入口 ============
export function apply(ctx) {
  const lastUserMsg = new Map();

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message.source?.kind !== "user") return;
    lastUserMsg.set(agent.id, Date.now());
    // ① 从用户消息里抽用餐事实
    const fact = extractMealFact(messageText(message));
    if (fact) recordFact(fact);
  });

  ctx.inject(["qqbot"], (inner) => {
    inner.effect(() =>
      inner.qqbot.runtime("life-state", (session) => {
        const now = new Date();
        const today = dayKey(now);

        let state = loadState();
        if (state === null || state.date !== today) {
          const history = state?.history ?? [];
          state = blankState(today);
          state.history = history;
        }

        const changed = backfill(state, now);

        const last = lastUserMsg.get(session.id);
        const isReturn = last === undefined || Date.now() - last >= RETURN_GAP_MS;
        const showReport = isReturn && state.report !== null && !state.report.mentioned;

        const text = renderLife(state, showReport, now);

        if (showReport) state.report.mentioned = true;
        if (changed || showReport) saveState(state);

        return text;
      })
    );
  });
}
