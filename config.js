import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

export default {
  siteGroupName: process.env.SITE_GROUP_NAME || 'SITE MANAGEMENT',
  siteGroupInvite: process.env.SITE_GROUP_INVITE || '',
  // Groups the bot is allowed to serve, comma separated group ids
  // (120363...@g.us). The bot also sits in family/personal groups, so it only
  // replies where this says it should. New groups can be claimed in-app with
  // `.site` instead of editing this file.
  siteGroups: process.env.SITE_GROUPS || '',
  adminNumbers: (process.env.ADMIN_NUMBERS || '').split(',').filter(Boolean),
  // Login by phone pairing code instead of QR scan (WhatsApp: Linked devices > Link with phone number)
  pairPhoneNumber: process.env.PAIR_PHONE_NUMBER || '',
  // The brain. Only fires when a user TAGS the bot - the group stays quiet
  // during normal chatter.
  //
  // "local" (default) = Ollama running qwen3:8b on this machine's RTX 4060.
  // No API key, no quota, no per-message cost, works offline, and it answers in
  // ~0.3-1.5s instead of the 8-17s the Gemini free tier managed before it ran
  // out of quota. Set LLM_PROVIDER=gemini to go back to the API.
  llmProvider: (process.env.LLM_PROVIDER || 'local').trim().toLowerCase(),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  // Comma separated, tried in order. First is the everyday brain; later ones are
  // only reached if it errors or returns something unusable.
  ollamaModels: (process.env.OLLAMA_MODELS || 'qwen3:8b')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  // KV-cache size in tokens. The SYSTEM_PROMPT is thousands of tokens on its own;
  // Ollama defaults to 4096, which truncates it and makes the model forget the
  // action schema entirely.
  ollamaNumCtx: Number(process.env.OLLAMA_NUM_CTX || 8192),
  // How long Ollama keeps the model in VRAM after a call. Default is 5 minutes,
  // and reloading costs ~90s - unacceptable when a message just arrived.
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || '24h',
  // Cap on one answer. Local is fast when warm, but the FIRST call after boot
  // pays the model load, so this has to cover it rather than time out mid-reply.
  llmBudgetMs: Number(process.env.LLM_BUDGET_MS || 45000),
  // How long ONE Gemini model gets before the chain moves on. 6s was too tight:
  // the real prompt is ~8k tokens, so the primary was aborted mid-prefill and
  // every request fell through to a slower fallback.
  geminiModelSliceMs: Number(process.env.GEMINI_MODEL_SLICE_MS || 20000),
  // Gemini 3 models "think" before answering, and those tokens count against
  // maxOutputTokens. A JSON reply then hits MAX_TOKENS before the JSON closes, so
  // the answer is thrown away. 0 disables it; set to -1 to restore the default.
  geminiThinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 0),
  geminiMaxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 1200),

  // Groq - OpenAI-compatible API, very fast, free tier. Primary brain now.
  groqApiKey: process.env.GROQ_API_KEY || '',
  groqBaseUrl: (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  groqModels: (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,qwen/qwen3.8-27b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Groq free tier caps the WHOLE request at 8k tokens/min. The full prompt is
  // ~8.4k on its own, so Groq gets a compact persona and a trimmed knowledge
  // slice. Measured in characters to keep it simple: ~3.7 chars/token.
  groqKnowledgeChars: Number(process.env.GROQ_KNOWLEDGE_CHARS || 6000),
  groqHistoryMessages: Number(process.env.GROQ_HISTORY_MESSAGES || 8),

  // Optional ElevenLabs voice for reminder notifications.
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsVoiceName: process.env.ELEVENLABS_VOICE_NAME || 'Bos Hue',
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',

  // Brain chain, tried in this order: if one is rate-limited or down, the next
  // answers. Empty LLM_CHAIN keeps the old single-provider behaviour.
  //   cerebras  - fastest, 1M tokens/day free, 30 RPM
  //   sambanova - big model, very high limits on the developer tier
  //   gemini    - Google AI Studio, 20 requests/day on the free key
  //   groq      - last-resort net so the bot still answers if the top three fail
  llmChain: (process.env.LLM_CHAIN || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  cerebrasApiKey: process.env.CEREBRAS_API_KEY || '',
  cerebrasBaseUrl: (process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1').replace(/\/+$/, ''),
  cerebrasModels: (process.env.CEREBRAS_MODELS || 'gpt-oss-120b,qwen-3.8-27b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  sambanovaApiKey: process.env.SAMBANOVA_API_KEY || '',
  sambanovaBaseUrl: (process.env.SAMBANOVA_BASE_URL || 'https://api.sambanova.ai/v1').replace(/\/+$/, ''),
  sambanovaModels: (process.env.SAMBANOVA_MODELS || 'Meta-Llama-3.3-70B-Instruct,gpt-oss-120b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Every decision (prompt -> JSON) appended to training/dataset.jsonl for
  // fine-tuning qwen on this bot's own traffic.
  logTrainingData: (process.env.LOG_TRAINING_DATA || 'true').toLowerCase() !== 'false',

  // Legacy: kept only so a rollback to the API needs no code change.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  // Display names that count as a mention of the bot (lowercase, no @)
  botAliases: (process.env.BOT_ALIASES || 'kerani,sitebot,site bot,bot')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  dateFormat: process.env.DATE_FORMAT || 'DD/MM/YYYY',
  timeFormat: process.env.TIME_FORMAT || 'HH:mm',
  databaseUrl: process.env.DATABASE_URL || '',
  // Origin only - tolerates a pasted https://xxx.supabase.co/rest/v1/
  supabaseUrl: process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  photoBucket: 'site-photos',

  // Each site gets its own Supabase bucket. Category/date are folders inside
  // that bucket; the bucket id is normalized from the site name in fileStore.

  // Personal claims are the owner's own receipts, forwarded in a PRIVATE chat.
  // They are deliberately NOT in fileCategories: they belong to a person, not to
  // a site, and must never show up in a site's file list or .files listing.
  personalBucket: 'personal-claims',

  // Every file sent in a site group is auto-saved. Each site has its own
  // Supabase bucket; category and date are folders inside that bucket.
  // Rename any bucket here if you already made one under a different name.
  fileCategories: {
    photos:   { bucket: 'site-photos',   label: 'Site Photos',  emoji: '📸' },
    attendance: { bucket: 'site',        label: 'Attendance',   emoji: '👷' },
    drawings: { bucket: 'site-drawings', label: 'Drawings',     emoji: '📐' },
    pdf:      { bucket: 'site-pdf',      label: 'PDF / Letters',emoji: '📄' },
    // Output, not input: anything the bot compiles/merges lands in its own
    // bucket so a finished booklet is never mistaken for a source document.
    compiled: { bucket: 'site-compile-pdf', label: 'Compiled PDF', emoji: '🧩' },
    voice:    { bucket: 'site-voice',    label: 'Voice Notes',  emoji: '🎤' },
    video:    { bucket: 'site-video',    label: 'Video',        emoji: '🎬' },
    other:    { bucket: 'site-files',    label: 'Other Files',  emoji: '📎' }
  },

  // Folder names inside each category bucket: <site>/<category>/<date>/<file>.
  fileCategoryFolders: {
    photos: 'photos', drawings: 'drawings', pdf: 'pdf', compiled: 'compiled',
    voice: 'voice', video: 'video', attendance: 'attendance', other: 'other'
  },

  // Explicit symbol routing - the "#claim" / "#progress" idea.
  //
  // A caption starting with one of these wins over the automatic classifier, so
  // the person sending the file decides where it goes instead of the bot
  // guessing. `folder` puts it in a named folder instead of the day folder, and
  // the same folder + name pair is what versioning is keyed on.
  fileSymbols: {
    '#photo':    { category: 'photos',   folder: null,        label: 'Site Photo' },
    '#gambar':   { category: 'photos',   folder: null,        label: 'Site Photo' },
    '#progress': { category: 'photos',   folder: 'Progress',  label: 'Progress Photo' },
    '#kemajuan': { category: 'photos',   folder: 'Progress',  label: 'Progress Photo' },
    '#drawing':  { category: 'drawings', folder: 'Drawings',  label: 'Drawing' },
    '#pelan':    { category: 'drawings', folder: 'Drawings',  label: 'Drawing' },
    '#lukisan':  { category: 'drawings', folder: 'Drawings',  label: 'Drawing' },
    '#dwg':      { category: 'drawings', folder: 'Drawings',  label: 'Drawing' },
    '#claim':    { category: 'pdf',      folder: 'Claims',    label: 'Claim' },
    '#tuntutan': { category: 'pdf',      folder: 'Claims',    label: 'Claim' },
    '#do':       { category: 'pdf',      folder: 'DO',        label: 'Delivery Order' },
    '#invoice':  { category: 'pdf',      folder: 'Invoices',  label: 'Invoice' },
    '#invois':   { category: 'pdf',      folder: 'Invoices',  label: 'Invoice' },
    '#report':   { category: 'pdf',      folder: 'Reports',   label: 'Report' },
    '#laporan':  { category: 'pdf',      folder: 'Reports',   label: 'Report' },
    '#site':     { category: 'other',    folder: null,        label: 'Site File' },
    '#pdf':      { category: 'pdf',      folder: null,        label: 'PDF' },
    '#voice':    { category: 'voice',    folder: null,        label: 'Voice Note' },
    '#video':    { category: 'video',    folder: null,        label: 'Video' },
    '#attendance': { category: 'attendance', folder: 'attendance', label: 'Attendance' }
  },

  // Reply like a person, not a machine: "typing..." before the first message of
  // a burst, then a short pause between the rest. This is the Meta-ban insurance
  // the group asked for; set HUMAN_TYPING=false to send instantly.
  humanTyping: (process.env.HUMAN_TYPING || 'true').toLowerCase() !== 'false',
  // Short human pause: natural enough for WhatsApp without making the user
  // wait 3-5 seconds for a simple answer.
  typingDelayMinMs: Number(process.env.TYPING_DELAY_MIN_MS || 1500),
  typingDelayMaxMs: Number(process.env.TYPING_DELAY_MAX_MS || 2800),

  // Successful saves only react with an emoji - no narration. Questions, views
  // and errors still reply in text. Set SILENT_ON_SUCCESS=false to get the old
  // "dah masuk boss" confirmations back.
  silentOnSuccess: (process.env.SILENT_ON_SUCCESS || 'true').toLowerCase() !== 'false',

  // How long files wait for a caption/record before being filed as "unlinked".
  // A separate description sent after a photo can still be linked to that
  // photo for 90 seconds. After that, require an explicit #category symbol.
  fileBatchWindowMs: 90 * 1000,
  maxFileBytes: 25 * 1024 * 1024,
  
  // Priority levels for issues
  priorities: {
    LOW: 'low',
    MEDIUM: 'medium', 
    HIGH: 'high',
    URGENT: 'urgent'
  },
  
  // Issue statuses
  issueStatus: {
    OPEN: 'open',
    IN_PROGRESS: 'in_progress',
    RESOLVED: 'resolved',
    CLOSED: 'closed'
  },
  
  // Work categories
  categories: [
    'Civil', 'Structural', 'MEP', 'Architecture', 
    'Interior', 'External', 'Safety', 'Others'
  ],
  
  // Material categories
  materialCategories: [
    'Concrete', 'Steel', 'Timber', 'Bricks', 'Sand', 
    'Aggregate', 'Cement', 'Pipes', 'Electrical', 
    'Plumbing', 'Finishing', 'Others'
  ]
};
