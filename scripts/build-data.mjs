#!/usr/bin/env node
/**
 * build-data.mjs — 构建时拉取 GitHub 数据，输出 data.js
 *
 * 用法：
 *   node scripts/build-data.mjs                       # 匿名：仓库/star/语言/topics/总数
 *   GH_PAT=ghp_xxx node scripts/build-data.mjs        # 带 token：额外拉真实贡献热力图
 *
 * 设计要点：
 *   - 只在「构建时」发请求，浏览器端零网络请求（data.js 是本地静态文件）
 *   - 无 token 也能跑，热力图自动回退到 repos.config.json 的 fallback
 *   - 仓库描述/标签走 repos.config.json 策展，star/语言等由 API 覆盖，互不打架
 *   - Node 18+ 内置 fetch，零依赖
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = process.env.GH_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const log = (...a) => console.log('[gh-data]', ...a);

// GitHub App 安装令牌（Actions 的 GITHUB_TOKEN）以 ghs_ 开头，不代表用户身份，
// 查 contributionsCollection 会静默返回空数据，这里提前拦一道避免白跑。
if (TOKEN.startsWith('ghs_')) {
  log('! 检测到 App 安装令牌(ghs_)，它无法读取贡献热力图，请改用个人 PAT (ghp_)');
}

/* ---------- 配置 ---------- */
async function readConfig() {
  try {
    return JSON.parse(await readFile(path.join(ROOT, 'repos.config.json'), 'utf8'));
  } catch {
    return { user: 'iqingyoung', pinned: [], curated: {}, discover: true, exclude: [], fallback: {} };
  }
}

/* ---------- GitHub 请求 ---------- */
const UA = 'portfolio-build-script';

async function rest(p) {
  const res = await fetch(`https://api.github.com${p}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': UA,
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${p} -> ${res.status}：GH_PAT 无效、已过期或权限不足，请检查仓库 secret（不配则删掉该变量，脚本会匿名运行）`);
  }
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`graphql -> ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data;
}

const CALENDAR_QUERY = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`;

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

function buildCalendar(data) {
  const cal = data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) return null;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.slice(-53).map((w) =>
      w.contributionDays.map((d) => ({
        date: d.date,
        count: d.contributionCount,
        level: LEVEL[d.contributionLevel] ?? 0,
      }))
    ),
    source: 'graphql',
  };
}

/** 无 token 时的兜底：沿用 config 里手工维护的热力图 */
function fallbackCalendar(fb = {}) {
  const active = fb.activeWeeks || {};
  const weeks = [];
  for (let w = 0; w < 52; w++) {
    const days = active[w] || [0, 0, 0, 0, 0, 0, 0];
    weeks.push(days.map((lv) => ({ date: null, count: lv, level: Math.min(lv, 4) })));
  }
  return { total: fb.totalContributions ?? null, weeks, source: 'fallback' };
}

/* ---------- 主流程 ---------- */
const cfg = await readConfig();
const login = cfg.user || 'iqingyoung';
log(`user = ${login}，token = ${TOKEN ? 'yes (含热力图)' : 'no (热力图走 fallback)'}`);

let user, repoList;
try {
  [user, repoList] = await Promise.all([
    rest(`/users/${login}`),
    rest(`/users/${login}/repos?per_page=100&sort=updated`),
  ]);
} catch (e) {
  console.error('[gh-data] ✗ 拉取失败：', e.message);
  process.exit(1);
}
log(`拉取到 ${repoList.length} 个公开仓库`);

const byName = new Map(repoList.map((r) => [r.name.toLowerCase(), r]));
const lower = (s) => String(s).toLowerCase();
const exclude = new Set((cfg.exclude || []).map(lower));
const curated = cfg.curated || {};
const pinned = (cfg.pinned || []).map(lower);

// 1) 策展置顶的先按 pinned 顺序入列（顺序 = 你写的顺序）
const picked = [];
for (const name of pinned) {
  const r = byName.get(name);
  if (r) picked.push(r);
  else log(`! 置顶仓库未找到或非公开：${name}`);
}

// 2) discover: 其余公开仓库自动追加（新增项目无需改任何文件）
if (cfg.discover !== false) {
  repoList
    .filter((r) => !pinned.includes(lower(r.name)) && !exclude.has(lower(r.name)) && !r.fork && !r.archived)
    .forEach((r) => picked.push(r));
}

const repos = picked
  .filter((r) => !exclude.has(lower(r.name)))
  .map((r) => {
    const c = curated[r.name] || {};
    return {
      name: r.name,
      displayName: c.displayName || r.name,
      url: r.html_url,
      description: c.description || r.description || '',
      stars: r.stargazers_count,
      language: r.language,
      topics: c.topics || r.topics || [],
      updatedAt: r.pushed_at,
      featured: pinned.includes(lower(r.name)),
    };
  });

const totalStars = repos.reduce((s, r) => s + r.stars, 0);
const languages = [...new Set(repos.map((r) => r.language).filter(Boolean))];

let calendar;
try {
  calendar = TOKEN ? buildCalendar(await graphql(CALENDAR_QUERY, { login })) : null;
} catch (e) {
  log('! 热力图拉取失败：', e.message);
}
calendar ||= fallbackCalendar(cfg.fallback);
log(`热力图来源 = ${calendar.source}`);

const payload = {
  generatedAt: new Date().toISOString(),
  user: {
    login: user.login,
    name: user.name,
    avatar: user.avatar_url,
    bio: user.bio,
    publicRepos: user.public_repos,
    followers: user.followers,
    htmlUrl: user.html_url,
  },
  totals: { repos: repos.length, stars: totalStars, languages: languages.length },
  repos,
  calendar,
};

await writeFile(
  path.join(ROOT, 'data.js'),
  `/* AUTO-GENERATED by scripts/build-data.mjs — 请勿手动编辑 */\n` +
    `window.GH_DATA = ${JSON.stringify(payload, null, 2)};\n`,
  'utf8'
);

log(`✅ 已写入 data.js — ${repos.length} 个仓库 / ★${totalStars} / 热力图 ${calendar.weeks.length} 周`);
