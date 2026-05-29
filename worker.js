/**
 * Cloudflare Worker - Project Tracker Notion Proxy
 *
 * 배포 방법:
 *  1. https://workers.cloudflare.com → "Create Worker" → 이 파일 전체 붙여넣기
 *  2. Settings → Variables and Secrets 에 아래 3개 추가 (모두 type: Secret 권장)
 *       NOTION_TOKEN        - Notion Integration 토큰 (secret_...)
 *       PROJECTS_DB_ID      - cfd767c9fad54e8a8db7a222c2d037c7
 *       HISTORY_DB_ID       - b9961a93722d4658a33e860494f66ef7
 *  3. 필요시 ALLOWED_ORIGIN 도 Variable 로 추가 (예: https://garam.github.io)
 *     설정하지 않으면 * 로 허용됩니다.
 */

const NOTION_VERSION = '2022-06-28';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const corsHeaders = buildCorsHeaders(request, env);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      let result;

      if (path === '/projects' && request.method === 'GET') {
        result = await listProjects(env);
      } else if (path === '/projects' && request.method === 'POST') {
        const body = await request.json();
        result = await createProject(env, body);
      } else if (path.startsWith('/projects/') && request.method === 'PATCH') {
        const id = decodeURIComponent(path.split('/')[2]);
        const body = await request.json();
        result = await updateProject(env, id, body);
      } else if (path.startsWith('/projects/') && request.method === 'DELETE') {
        const id = decodeURIComponent(path.split('/')[2]);
        result = await deleteProject(env, id);
      } else if (path === '/history' && request.method === 'POST') {
        const body = await request.json();
        result = await addHistory(env, body);
      } else if (path === '/' && request.method === 'GET') {
        result = { ok: true, message: 'Project Tracker Worker alive' };
      } else {
        return jsonResponse({ error: 'Not found', path }, 404, corsHeaders);
      }

      return jsonResponse(result, 200, corsHeaders);
    } catch (err) {
      return jsonResponse(
        { error: err.message || String(err), stack: err.stack },
        500,
        corsHeaders
      );
    }
  },
};

/* ---------- CORS ---------- */

function buildCorsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin') || '*';
  const allowed = (env.ALLOWED_ORIGIN || '*').trim();
  // ALLOWED_ORIGIN 에 콤마로 여러 도메인 등록 가능
  let origin = '*';
  if (allowed === '*') {
    origin = '*';
  } else {
    const list = allowed.split(',').map(s => s.trim());
    origin = list.includes(requestOrigin) ? requestOrigin : list[0];
  }
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
    },
  });
}

/* ---------- Notion fetch helper ---------- */

async function notionFetch(env, path, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Notion API ${res.status}: ${data.message || text}`);
  }
  return data;
}

/* ---------- Property serializers ---------- */

const richText = v => v ? [{ type: 'text', text: { content: String(v).slice(0, 2000) } }] : [];
const title = v => v ? [{ type: 'text', text: { content: String(v).slice(0, 200) } }] : [];

function readText(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(t => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('');
  return '';
}
function readSelect(prop) { return prop && prop.select ? prop.select.name : ''; }
function readNumber(prop) { return prop && typeof prop.number === 'number' ? prop.number : 0; }
function readDate(prop) { return prop && prop.date ? prop.date.start : ''; }

/* ---------- Projects ---------- */

async function listProjects(env) {
  // Pull all projects from main DB
  const projectsResp = await notionFetch(env, `/databases/${env.PROJECTS_DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 100,
      sorts: [{ property: 'Order', direction: 'ascending' }],
    }),
  });

  // Pull all history rows (≤ 100 for now)
  const historyResp = await notionFetch(env, `/databases/${env.HISTORY_DB_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      page_size: 100,
      sorts: [{ property: 'Date', direction: 'ascending' }],
    }),
  });

  // Group history by project page id
  const historyByProject = {};
  for (const row of historyResp.results) {
    const rel = row.properties.Project?.relation || [];
    const projectId = rel[0]?.id;
    if (!projectId) continue;
    (historyByProject[projectId] ||= []).push({
      id: row.id,
      v: readText(row.properties.Version),
      date: readDate(row.properties.Date),
      note: readText(row.properties.Note),
      createdTime: row.created_time,
    });
  }

  const projects = projectsResp.results.map(p => ({
    id: p.id,
    name: readText(p.properties.Name),
    category: readSelect(p.properties.Category) || 'tool',
    status: readSelect(p.properties.Status) || 'todo',
    pct: Math.round((readNumber(p.properties.Progress) || 0) * 100),
    version: readText(p.properties.Version) || 'v0.1',
    desc: readText(p.properties.Description),
    milestone: readText(p.properties.Milestone),
    next: readText(p.properties.Next),
    workspace: readText(p.properties.Workspace),
    createdAt: readDate(p.properties.CreatedAt),
    order: readNumber(p.properties.Order),
    history: (historyByProject[p.id] || []).sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return a.createdTime < b.createdTime ? -1 : 1;
    }),
  }));

  return { projects };
}

function buildProjectProps(input, isCreate) {
  const props = {};
  if (input.name !== undefined) props.Name = { title: title(input.name) };
  if (input.category !== undefined) props.Category = { select: { name: input.category } };
  if (input.status !== undefined) props.Status = { select: { name: input.status } };
  if (input.pct !== undefined) props.Progress = { number: (Number(input.pct) || 0) / 100 };
  if (input.version !== undefined) props.Version = { rich_text: richText(input.version) };
  if (input.desc !== undefined) props.Description = { rich_text: richText(input.desc) };
  if (input.milestone !== undefined) props.Milestone = { rich_text: richText(input.milestone) };
  if (input.next !== undefined) props.Next = { rich_text: richText(input.next) };
  if (input.workspace !== undefined) props.Workspace = { rich_text: richText(input.workspace) };
  if (isCreate && input.createdAt) props.CreatedAt = { date: { start: input.createdAt } };
  if (input.order !== undefined) props.Order = { number: Number(input.order) || 0 };
  return props;
}

async function createProject(env, body) {
  const props = buildProjectProps(body, true);
  const created = await notionFetch(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.PROJECTS_DB_ID },
      properties: props,
    }),
  });

  // Auto-add first history entry
  if (body.version) {
    await addHistory(env, {
      projectId: created.id,
      version: body.version,
      date: body.createdAt || new Date().toISOString().slice(0, 10),
      note: '최초 등록',
    });
  }
  return { id: created.id };
}

async function updateProject(env, id, body) {
  const props = buildProjectProps(body, false);
  await notionFetch(env, `/pages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties: props }),
  });
  return { id, ok: true };
}

async function deleteProject(env, id) {
  // Notion has no hard delete via API; archive instead.
  await notionFetch(env, `/pages/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  return { id, archived: true };
}

/* ---------- History ---------- */

async function addHistory(env, body) {
  const props = {
    Label: { title: title(`${body.version || ''} ${body.note || ''}`.trim() || 'entry') },
    Project: { relation: [{ id: body.projectId }] },
    Version: { rich_text: richText(body.version || '') },
    Date: { date: { start: body.date || new Date().toISOString().slice(0, 10) } },
    Note: { rich_text: richText(body.note || '') },
  };
  const created = await notionFetch(env, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: env.HISTORY_DB_ID },
      properties: props,
    }),
  });
  return { id: created.id };
}
