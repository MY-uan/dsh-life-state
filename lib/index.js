// dsh-life-state — 角色「过日子」：主人不在时也有一天的生活。
//
// 设计（和阿鱼一起定的）：
// - 状态文件 <DSH_HOME>/qqbot/life-state.json，按「时段」惰性补齐：到点才抽、未来的留空。
// - 生成是纯本地随机（Math.random），不调模型、不花 token、不往会话发消息。
// - 注入走 ctx.qqbot.runtime()，进 qqbot:runtime context，跟时间插件挨着；
//   不带心情（情绪让角色按「距上次对话」自己推）。
// - 没装 dsh-qqbot 时安静什么都不做。

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const name = "dsh-life-state";

// ---------- 事件池 ----------
const MEALS = ["白饭配咸鱼", "蛋炒饭", "两个饭团", "剩汤浇饭"];

// 家务：text 是抽到的内容，cooldownDays 是同一件事几天内不再抽
const CHORES = [
  { text: "洗围裙", cooldownDays: 3 },
  { text: "擦桌子", cooldownDays: 2 },
  { text: "晾衣服", cooldownDays: 3 },
  { text: "把米桶补满", cooldownDays: 7 },
];

// 家务 → 汇报位（回来可提的一句话）
const CHORE_REPORT = {
  "洗围裙": "把围裙洗了晾在阳台上",
  "擦桌子": "把桌子擦了一遍",
  "晾衣服": "把衣服晾好了",
  "把米桶补满": "把米桶补满了",
};

// 小倒霉：只限角色自己，不碰主人的东西
const MISHAPS = ["把米洒了一地", "尾巴撞到桌角"];

// 各时段「到点」阈值（当天第几分钟）
const SLOT_MINUTES = {
  breakfast: 8 * 60, // 08:00
  chore: 10 * 60,    // 10:00
  lunch: 12 * 60,    // 12:00
  nap: 14 * 60,      // 14:00
  mishap: 16 * 60,   // 16:00
  dinner: 18 * 60,   // 18:00
};

const MISHAP_CHANCE = 0.15;            // 小倒霉概率
const HISTORY_DAYS = 7;                // 历史保留天数
const RETURN_GAP_MS = 30 * 60 * 1000;  // 汇报位「回来才提」的间隔阈值

// ---------- 小工具 ----------
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

function minutesOfDay(d) {
  return d.getHours() * 60 + d.getMinutes();
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
  } catch {
    // 写失败不影响提示词
  }
}

function blankState(date) {
  return {
    date,
    slots: {
      breakfast: null,
      lunch: null,
      nap: null,
      dinner: null,
      chore: null,
      mishap: null,
    },
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

function pickChore(state) {
  const now = Date.now();
  const available = CHORES.filter((c) => {
    const last = lastDoneAt(state, c.text);
    if (last === null) return true;
    return (now - last) / (24 * 60 * 60 * 1000) >= c.cooldownDays;
  });
  if (available.length === 0) return null;
  return pick(available);
}

function makeReport(state) {
  const s = state.slots;
  if (s.chore) return CHORE_REPORT[s.chore] || `今天${s.chore}`;
  if (s.mishap) return `今天${s.mishap}`;
  if (s.nap) return `午后睡了${s.nap}`;
  return null;
}

// 惰性补齐：到点才抽、未来留空。返回是否有改动。
function backfill(state, now) {
  const minute = minutesOfDay(now);
  let changed = false;
  const s = state.slots;

  if (s.breakfast === null && minute >= SLOT_MINUTES.breakfast) {
    s.breakfast = pick(MEALS);
    changed = true;
  }
  if (s.chore === null && minute >= SLOT_MINUTES.chore) {
    const chore = pickChore(state);
    if (chore) {
      s.chore = chore.text;
      pushHistory(state, chore.text, "chore");
    } else {
      s.chore = ""; // 都在冷却，今天不干家务
    }
    changed = true;
  }
  if (s.lunch === null && minute >= SLOT_MINUTES.lunch) {
    s.lunch = pick(MEALS);
    changed = true;
  }
  if (s.nap === null && minute >= SLOT_MINUTES.nap) {
    s.nap = `${randInt(20, 60)} 分钟`;
    changed = true;
  }
  if (s.mishap === null && minute >= SLOT_MINUTES.mishap) {
    s.mishap = Math.random() < MISHAP_CHANCE ? pick(MISHAPS) : "";
    if (s.mishap) pushHistory(state, s.mishap, "mishap");
    changed = true;
  }
  if (s.dinner === null && minute >= SLOT_MINUTES.dinner) {
    s.dinner = pick(MEALS);
    changed = true;
  }

  if (state.report === null) {
    const text = makeReport(state);
    if (text) {
      state.report = { text, mentioned: false };
      changed = true;
    }
  }

  return changed;
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

function renderLife(state, showReport) {
  const lines = [];
  const s = state.slots;
  const today = [];

  if (s.breakfast) today.push(`早餐=${s.breakfast}`);
  if (s.lunch) today.push(`午餐=${s.lunch}`);
  if (s.nap) today.push(`午睡=${s.nap}`);
  if (s.dinner) today.push(`晚餐=${s.dinner}`);
  if (s.chore) today.push(`家务=${s.chore}`);
  if (s.mishap) today.push(`小倒霉=${s.mishap}`);

  if (today.length > 0) {
    lines.push(`今日生活：${today.join("；")}。`);
  }

  if (showReport && state.report && !state.report.mentioned) {
    lines.push(`今天还没跟你提过的：${state.report.text}。`);
  }

  // 最近几天（给连续性，最多 3 条，不含今天）
  const recent = (state.history || []).filter((h) => h.date !== state.date).slice(-3);
  if (recent.length > 0) {
    const parts = recent.map((h) => `${relativeDay(h.date, state.date)}${h.event}`);
    lines.push(`前些天：${parts.join("、")}。`);
  }

  return lines.join("\n");
}

export function apply(ctx) {
  // 追踪「主人上次说话时间」，给汇报位判断「是不是回来了」用。
  const lastUserMsg = new Map(); // sessionId -> 毫秒时间戳

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message.source?.kind !== "user") return;
    lastUserMsg.set(agent.id, Date.now());
  });

  ctx.inject(["qqbot"], (inner) => {
    inner.effect(() =>
      inner.qqbot.runtime("life-state", (session) => {
        const now = new Date();
        const today = localDateKey(now);

        // 读文件 → 跨天/首次则重置（保留历史）
        let state = loadState();
        if (state === null || state.date !== today) {
          const history = state?.history ?? [];
          state = blankState(today);
          state.history = history;
        }

        // 惰性补齐（到点才抽、未来留空）
        const changed = backfill(state, now);

        // 判断「回来了」：距主人上次说话超过阈值
        const last = lastUserMsg.get(session.id);
        const isReturn = last === undefined || Date.now() - last >= RETURN_GAP_MS;
        const showReport = isReturn && state.report !== null && !state.report.mentioned;

        const text = renderLife(state, showReport);

        // 汇报位是「一次性」的：注入过就标记已提
        if (showReport) state.report.mentioned = true;
        if (changed || showReport) saveState(state);

        return text;
      })
    );
  });
}
