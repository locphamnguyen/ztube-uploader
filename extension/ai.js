// Gọi AI CHỈ khi một bước bị kẹt. Mỗi lần trả về đúng một thao tác cho content script thực hiện.
// Hỗ trợ Claude (Anthropic) và các API chuẩn OpenAI: OpenAI, Qwen (DashScope), Grok (xAI).
// Thử lần lượt các nhà cung cấp có API key theo thứ tự ưu tiên; nhà cung cấp lỗi thì chuyển sang cái tiếp theo.

export const PROVIDERS = {
  anthropic: {
    label: "Claude (Anthropic)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-5-5",
    keyHint: "sk-ant-…",
  },
  openai: {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    keyHint: "sk-…",
  },
  qwen: {
    label: "Qwen (Alibaba DashScope)",
    kind: "openai",
    // Tài khoản Trung Quốc đại lục: https://dashscope.aliyuncs.com/compatible-mode/v1
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-max",
    keyHint: "sk-…",
  },
  grok: {
    label: "Grok (xAI)",
    kind: "openai",
    baseUrl: "https://api.x.ai/v1",
    model: "grok-4",
    keyHint: "xai-…",
  },
};

const SYSTEM = `You help an automated YouTube Studio uploader that got stuck on one step of the "Upload videos" dialog.
You see the step goal, the error, a numbered list of visible interactive elements (and maybe a screenshot).
Reply by calling the "act" tool exactly once with ONE next action:
- click / type / scroll an element by its index, press a key, or wait;
- "retry_step" when the page now looks ready for the automation to redo the failed step itself;
- "skip_step" only if the step is optional and cannot be done (e.g. thumbnail upload unavailable);
- "give_up" if a human is needed (sign-in, verification, copyright/policy warning, unclear state).
Never delete, discard or cancel an upload. Never change channel settings. Prefer the smallest action that unblocks the step.`;

const ACT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "type", "scroll", "key", "wait", "retry_step", "skip_step", "give_up"] },
    index: { type: "integer", description: "Element index from the list (click/type/scroll)." },
    text: { type: "string", description: "Text to type (type action)." },
    key: { type: "string", description: "Key name, e.g. Escape or Enter (key action)." },
    ms: { type: "integer", description: "Milliseconds to wait (wait action, max 15000)." },
    reason: { type: "string", description: "One short sentence: why this action." },
  },
  required: ["action", "reason"],
};
const ACT_DESC = "Choose the single next action for the stuck uploader.";

function buildPrompt({ job, failure, snapshot, history }) {
  const facts = {
    step: `${failure.id} — ${failure.label}${failure.optional ? " (optional)" : ""}`,
    error: failure.message,
    wanted: {
      title: job.title,
      visibility: job.visibility,
      madeForKids: !!job.madeForKids,
      alteredContent: !!job.alteredContent,
      videoLanguage: job.videoLanguage,
      titleLanguage: job.titleLanguage,
      tags: job.tags,
    },
    page: { url: snapshot.url, heading: snapshot.heading },
    previousAiActions: history,
  };
  return `Stuck state:\n${JSON.stringify(facts, null, 1)}\n\nVisible elements:\n${JSON.stringify(snapshot.elements)}`;
}

async function postJson(url, headers, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

async function callAnthropic(cfg, prompt, screenshot) {
  const content = [{ type: "text", text: prompt }];
  if (screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot.split(",")[1] } });
  const data = await postJson(
    `${cfg.baseUrl}/messages`,
    { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    {
      model: cfg.model,
      max_tokens: 400,
      system: SYSTEM,
      tools: [{ name: "act", description: ACT_DESC, input_schema: ACT_SCHEMA }],
      tool_choice: { type: "tool", name: "act" },
      messages: [{ role: "user", content }],
    }
  );
  const call = (data.content || []).find((c) => c.type === "tool_use");
  if (!call) throw new Error("không trả về thao tác");
  return call.input;
}

// OpenAI chính hãng: dùng /responses. Model mới (vd gpt-6-luna) từ chối function tools kèm suy luận ở
// /chat/completions ("use /v1/responses or set reasoning_effort to 'none'"); /responses nhận được mọi model hiện hành.
async function callOpenAIResponses(cfg, prompt, screenshot) {
  const content = [{ type: "input_text", text: prompt }];
  if (screenshot) content.push({ type: "input_image", image_url: screenshot });
  const data = await postJson(
    `${cfg.baseUrl}/responses`,
    { authorization: `Bearer ${cfg.key}` },
    {
      model: cfg.model,
      instructions: SYSTEM,
      input: [{ role: "user", content }],
      tools: [{ type: "function", name: "act", description: ACT_DESC, parameters: ACT_SCHEMA }],
      tool_choice: { type: "function", name: "act" },
      max_output_tokens: 4000, // gồm cả token suy luận
      store: false,
    }
  );
  const call = (data.output || []).find((o) => o.type === "function_call" && o.name === "act");
  if (call) return JSON.parse(call.arguments || "{}");
  const text = (data.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("\n");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error(data.incomplete_details?.reason ? `không trả về thao tác (${data.incomplete_details.reason})` : "không trả về thao tác");
}

async function callOpenAICompatible(cfg, prompt, screenshot) {
  if (/api\.openai\.com/i.test(cfg.baseUrl)) return callOpenAIResponses(cfg, prompt, screenshot);
  const content = screenshot
    ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: screenshot } }]
    : prompt;
  // Qwen/Grok/cổng tương thích khác: chuẩn chat completions.
  const data = await postJson(
    `${cfg.baseUrl}/chat/completions`,
    { authorization: `Bearer ${cfg.key}` },
    {
      model: cfg.model,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
      tools: [{ type: "function", function: { name: "act", description: ACT_DESC, parameters: ACT_SCHEMA } }],
      tool_choice: { type: "function", function: { name: "act" } },
    }
  );
  const msg = data.choices?.[0]?.message;
  const call = msg?.tool_calls?.find((c) => c.function?.name === "act");
  if (call) return JSON.parse(call.function.arguments || "{}");
  // Một số model trả JSON trong content thay vì tool_calls.
  const m = (msg?.content || "").match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("không trả về thao tác");
}

async function callProvider(cfg, prompt, screenshot) {
  const fn = cfg.kind === "anthropic" ? callAnthropic : callOpenAICompatible;
  try {
    return await fn(cfg, prompt, screenshot);
  } catch (e) {
    // Model không nhận ảnh (vd model chỉ văn bản) → thử lại không kèm ảnh.
    if (screenshot && e.status === 400) return fn(cfg, prompt, null);
    throw e;
  }
}

// settings.ai = { order: ["anthropic", ...], providers: { anthropic: { key, model, baseUrl }, ... } }
export function configuredProviders(aiSettings) {
  const order = aiSettings?.order?.length ? aiSettings.order : Object.keys(PROVIDERS);
  return order
    .filter((id) => PROVIDERS[id] && aiSettings?.providers?.[id]?.key)
    .map((id) => {
      const p = aiSettings.providers[id];
      return { id, ...PROVIDERS[id], key: p.key, model: p.model || PROVIDERS[id].model, baseUrl: (p.baseUrl || PROVIDERS[id].baseUrl).replace(/\/+$/, "") };
    });
}

export async function askAI({ aiSettings, job, failure, snapshot, screenshot, history, log }) {
  const providers = configuredProviders(aiSettings);
  if (!providers.length) throw new Error("Chưa có API key AI nào");
  const prompt = buildPrompt({ job, failure, snapshot, history });
  const errors = [];
  for (const cfg of providers) {
    try {
      const act = await callProvider(cfg, prompt, screenshot);
      if (!act?.action) throw new Error("thao tác rỗng");
      return { ...act, provider: cfg.label };
    } catch (e) {
      errors.push(`${cfg.label}: ${e.message}`);
      log?.(`  ${cfg.label} lỗi (${e.message.slice(0, 120)}) — thử nhà cung cấp kế tiếp`);
    }
  }
  throw new Error(`Tất cả nhà cung cấp AI đều lỗi — ${errors.join(" | ")}`);
}
