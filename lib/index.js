// dsh-life-state — 角色「过日子」：主人不在时也有一天的生活。
//
// v2（和阿鱼一起定的第二批）：
// - 按五个时段惰性补齐：早晨 6–11 / 中午 11–15 / 下午 15–18 / 傍晚 18–23 / 深夜 23–6。
//   只补「已过去且还空着」的时段，未来的留空。
// - 每个时段独立事件池；事件给「动作」不给「结果」；允许某时段留空；事件能连成链。
// - 注入只渲最近两三条，不带硬心情；留一行「回来可提」。
// - 纯本地随机，不调模型、不花 token、不往会话发消息。

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const name = "dsh-life-state";

// ============ 时段定义 ============
// 「生活日」从早晨 6:00 开始：dayMinute(now) = 距离 6:00 的分钟数（0~1439）。
// 各时段 endMinute = 这个时段结束时的 dayMinute。
const PERIODS = [
  { key: "morning",   label: "早晨", endMinute: 300 },   // 6:00–11:00
  { key: "noon",      label: "中午", endMinute: 540 },   // 11:00–15:00
  { key: "afternoon", label: "下午", endMinute: 720 },   // 15:00–18:00
  { key: "evening",   label: "傍晚", endMinute: 1020 },  // 18:00–23:00
  { key: "latenight", label: "深夜", endMinute: 1440 },  // 23:00–次日6:00
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
  "把米洒了一地，蹲着捡了半天",
  "尾巴撞到桌角，抱着揉了好一会儿",
  "打翻了一杯水，手忙脚乱擦干",
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
  afternoon: 0.3,   // 下午有时就是没事
  evening: 0.1,     // 傍晚通常有晚饭，但心情可能留空
  latenight: 0.4,   // 深夜经常就是直接睡了
};

const MISHAP_CHANCE = 0.15;            // 小倒霉概率（在「下午」家务里掺）
const HISTORY_DAYS = 7;                // 历史保留天数
const RETURN_GAP_MS = 30 * 60 * 1000;  // 汇报位「回来才提」的间隔阈值

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

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    if (raw && typeof raw === "object" && typeof raw.date === "string") return raw;
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
    report: null, // { text, mentioned }
    history: [],  // [{ date, event, category, at }]
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

// 抽一件家务：先看有没有「连链」的（前置条件满足的），再看普通池；都不行返回 null。
function pickAfternoonChore(state) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // 连链：只在前置事件最近出现过时才可抽
  const chained = AFTERNOON_CHORES.filter((c) => c.requires);
  for (const c of chained) {
    const req = lastDoneAt(state, c.requires);
    if (req !== null && (now - req) / dayMs <= (c.requiresWithinDays ?? 2)) {
      const lastSelf = lastDoneAt(state, c.key);
      if (lastSelf === null || (now - lastSelf) / dayMs >= (c.cooldownDays ?? 3)) {
        return c;
      }
    }
  }

  const regular = AFTERNOON_CHORES.filter((c) => !c.requires).filter((c) => {
    const last = lastDoneAt(state, c.key);
    if (last === null) return true;
    return (now - last) / dayMs >= (c.cooldownDays ?? 3);
  });

  if (regular.length === 0) return null;
  return pick(regular);
}

function makeReport(state) {
  // 挑当天最「可说」的一句：优先家务/小倒霉，其次午睡/睡前小事
  const s = state.periods;
  if (s.afternoon) return s.afternoon;
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

  // 早晨（已过去且空着才补）
  if (p.morning === null && dm >= PERIODS[0].endMinute) {
    const breakfast = pick(MORNING_BREAKFASTS);
    const chore = pick(MORNING_CHORES);
    pushHistory(state, chore, "chore");
    p.morning = `${breakfast}；${chore}`;
    changed = true;
  }

  // 中午
  if (p.noon === null && dm >= PERIODS[1].endMinute) {
    const lunch = pick(NOON_LUNCHES);
    const nap = pick(NOON_NAPS);
    p.noon = `${lunch}；${nap}`;
    changed = true;
  }

  // 下午（可能留空；家务或小倒霉）
  if (p.afternoon === null && dm >= PERIODS[2].endMinute) {
    if (Math.random() < (EMPTY_CHANCE.afternoon ?? 0)) {
      p.afternoon = "";
    } else if (Math.random() < MISHAP_CHANCE) {
      const mishap = pick(AFTERNOON_MISHAPS);
      pushHistory(state, mishap, "mishap");
      p.afternoon = mishap;
    } else {
      const chore = pickAfternoonChore(state);
      if (chore) {
        pushHistory(state, chore.key, "chore");
        p.afternoon = chore.text;
      } else {
        p.afternoon = ""; // 都在冷却，就留空
      }
    }
    changed = true;
  }

  // 傍晚（晚餐 + 软心情；心情可能留空）
  if (p.evening === null && dm >= PERIODS[3].endMinute) {
    const dinner = pick(EVENING_DINNERS);
    const mood = Math.random() < (EMPTY_CHANCE.evening ?? 0) ? "" : pick(EVENING_MOODS);
    p.evening = mood ? `${dinner}；${mood}` : dinner;
    changed = true;
  }

  // 深夜（睡前小事，可能留空）
  if (p.latenight === null && dm >= PERIODS[4].endMinute) {
    if (Math.random() < (EMPTY_CHANCE.latenight ?? 0)) {
      p.latenight = "";
    } else {
      p.latenight = pick(LATE_NIGHT_RITUALS);
    }
    changed = true;
  }

  // 汇报位：当天最可说的一句
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
// 0–6 点还挂在「前一天」，前缀叫「昨晚」；6 点起叫「今日」。
function lifePrefix(now) {
  return dayKey(now) === localDateKey(now) ? "今日" : "昨晚";
}

function renderLife(state, showReport, now) {
  const lines = [];

  // 只渲最近两三条：把非空的时段按时间顺序收集，取最后 3 条
  const filled = PERIODS.map((pd) => ({ label: pd.label, text: state.periods[pd.key] }))
    .filter((x) => x.text);
  const recent = filled.slice(-3);

  if (recent.length > 0) {
    const parts = recent.map((x) => `${x.label} ${x.text}`);
    lines.push(`${lifePrefix(now)}：${parts.join("；")}。`);
  }

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
  const lastUserMsg = new Map(); // sessionId -> 毫秒时间戳

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message.source?.kind !== "user") return;
    lastUserMsg.set(agent.id, Date.now());
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
