import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, AlertCircle, ArrowDown, ArrowRight, BookOpen, Check,
  CircleHelp, ClipboardList, Clock3, Download, FileText, HeartPulse, ImagePlus,
  Info, PanelRight, Menu, MessageCircle, MoreHorizontal, Plus, Search,
  Send, Settings2, ShieldCheck, Stethoscope, ThumbsDown, ThumbsUp,
  Trash2, X,
} from 'lucide-react'

type Evidence = { id: string; title: string; category: string; excerpt: string; source: string }
type TraceStep = { label: string; detail: string; status: string }
type Reply = {
  session_id: string; answer: string; route: 'single' | 'swarm'; agents: string[]
  evidence: Evidence[]; trace: TraceStep[]; high_risk: boolean
  mode: 'demo' | 'live'; image_analyzed: boolean; elapsed_ms: number
}
type Message = { id: string; role: 'user' | 'assistant'; content: string; image?: string; reply?: Reply; feedback?: 'up' | 'down' }
type Conversation = { id: string; title: string; messages: Message[]; updated: number }
type ApiStatus = { status: string; mode: 'demo' | 'live'; vision_enabled: boolean }

const STORAGE_KEY = 'medix-care-conversations-v1'
const prompts = [
  { icon: HeartPulse, title: '症状咨询', text: '最近头晕和乏力，需要关注哪些情况？' },
  { icon: BookOpen, title: '知识检索', text: '高血压日常管理有哪些通用建议？' },
  { icon: ClipboardList, title: '报告理解', text: '看检查报告时，参考范围和单位为什么重要？' },
  { icon: ShieldCheck, title: '风险识别', text: '出现胸痛和呼吸困难时应该怎么办？' },
]

function loadConversations(): Conversation[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function safeMarkdown(text: string) {
  return text.split('\n').map((line, index) => <span key={index}>{line.split(/(\*\*[^*]+\*\*)/g).map((part, partIndex) => part.startsWith('**') && part.endsWith('**') ? <strong key={partIndex}>{part.slice(2, -2)}</strong> : part)}<br /></span>)
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations)
  const [currentId, setCurrentId] = useState<string | null>(() => loadConversations()[0]?.id || null)
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [token, setToken] = useState(() => sessionStorage.getItem('medix-care-token') || '')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'evidence' | 'trace'>('evidence')
  const [search, setSearch] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [showJump, setShowJump] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const current = conversations.find(item => item.id === currentId)
  const selectedReply = [...(current?.messages || [])].reverse().find(item => item.reply)?.reply
  const filtered = useMemo(() => conversations.filter(item => item.title.toLowerCase().includes(search.toLowerCase())), [conversations, search])

  useEffect(() => {
    const withoutImages = conversations.map(item => ({ ...item, messages: item.messages.map(({ image, ...message }) => message) }))
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(withoutImages))
  }, [conversations])
  useEffect(() => { sessionStorage.setItem('medix-care-token', token) }, [token])
  useEffect(() => {
    fetch('/api/health').then(response => response.json()).then(setStatus).catch(() => setStatus(null))
  }, [])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [current?.messages.length, busy])
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        newConversation()
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [])

  function newConversation() {
    setCurrentId(null)
    setDraft('')
    setAttachment(null)
    setFileName('')
    setError('')
    setSidebarOpen(false)
    textareaRef.current?.focus()
  }

  function deleteConversation(id: string) {
    setConversations(items => items.filter(item => item.id !== id))
    if (currentId === id) setCurrentId(null)
    setOpenMenu(null)
  }

  function downloadConversation(item: Conversation) {
    const content = [`# ${item.title}`, '', ...item.messages.flatMap(message => [
      `## ${message.role === 'user' ? '提问' : 'MediX Care'}`, '', message.content,
      ...(message.reply?.evidence.length ? ['', '参考知识卡：' + message.reply.evidence.map(card => card.title).join('、')] : []), '',
    ])].join('\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `medix-${new Date(item.updated).toISOString().slice(0, 10)}.md`
    link.click()
    URL.revokeObjectURL(url)
    setOpenMenu(null)
  }

  async function sendMessage(override?: string) {
    const text = (override ?? draft).trim()
    if (!text || busy) return
    const id = currentId || crypto.randomUUID()
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text, image: attachment || undefined }
    const history = (current?.messages || []).slice(-10).map(item => ({ role: item.role, content: item.content }))
    setCurrentId(id)
    setConversations(items => {
      const exists = items.find(item => item.id === id)
      if (exists) return items.map(item => item.id === id ? { ...item, messages: [...item.messages, userMessage], updated: Date.now() } : item)
      return [{ id, title: text.slice(0, 25), messages: [userMessage], updated: Date.now() }, ...items]
    })
    setDraft('')
    setAttachment(null)
    setFileName('')
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Medix-Access-Token': token } : {}) },
        body: JSON.stringify({ message: text, session_id: id, history, image: userMessage.image || null }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || '请求失败，请稍后重试')
      const reply = result as Reply
      setConversations(items => items.map(item => item.id === id ? {
        ...item, messages: [...item.messages, { id: crypto.randomUUID(), role: 'assistant', content: reply.answer, reply }], updated: Date.now(),
      } : item))
    } catch (cause) {
      setConversations(items => items.map(item => item.id === id ? {
        ...item, messages: item.messages.filter(message => message.id !== userMessage.id),
      } : item).filter(item => item.messages.length > 0))
      if (!currentId) setCurrentId(null)
      setDraft(text)
      setAttachment(userMessage.image || null)
      setError(cause instanceof Error ? cause.message : '请求失败，请稍后重试')
    } finally { setBusy(false) }
  }

  function onFile(file?: File) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('请选择不超过 5 MB 的 JPEG、PNG 或 WebP 图片')
      return
    }
    const reader = new FileReader()
    reader.onload = () => { setAttachment(String(reader.result)); setFileName(file.name); setError('') }
    reader.readAsDataURL(file)
  }

  function setFeedback(messageId: string, feedback: 'up' | 'down') {
    setConversations(items => items.map(item => item.id === currentId ? {
      ...item, messages: item.messages.map(message => message.id === messageId ? { ...message, feedback: message.feedback === feedback ? undefined : feedback } : message),
    } : item))
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭会话列表" />}
      {inspectorOpen && <button className="inspector-scrim" onClick={() => setInspectorOpen(false)} aria-label="关闭信息面板" />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand-mark"><HeartPulse size={21} strokeWidth={2.4} /></div>
          <div className="brand-text"><strong>MediX Care</strong><span>医疗知识协作台</span></div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="关闭侧栏"><X size={18} /></button>
        </div>
        <button className="new-chat" onClick={newConversation}><Plus size={18} /> 新建对话 <span>⌘ K</span></button>
        <div className="sidebar-search"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索对话" aria-label="搜索对话" /></div>
        <div className="sidebar-section-title">最近对话 <span>{conversations.length}</span></div>
        <div className="conversations">
          {filtered.length ? filtered.map(item => <div key={item.id} className={`conversation-row ${currentId === item.id ? 'active' : ''}`}>
            <button className="conversation-select" onClick={() => { setCurrentId(item.id); setSidebarOpen(false); setError('') }}>
              <MessageCircle size={16} /><span>{item.title}</span>
            </button>
            <button className="icon-button conversation-menu-button" onClick={() => setOpenMenu(openMenu === item.id ? null : item.id)} title="对话操作" aria-label="对话操作"><MoreHorizontal size={17} /></button>
            {openMenu === item.id && <div className="conversation-menu">
              <button onClick={() => downloadConversation(item)}><Download size={15} /> 导出记录</button>
              <button className="danger" onClick={() => deleteConversation(item.id)}><Trash2 size={15} /> 删除对话</button>
            </div>}
          </div>) : <div className="no-conversation">暂无匹配的对话</div>}
        </div>
        <div className="sidebar-bottom">
          <div className="system-state"><span className={`state-dot ${status ? '' : 'offline'}`} /> <span>{status?.mode === 'live' ? '模型服务已连接' : status ? '演示模式可用' : '服务未连接'}</span><ArrowRight size={14} /></div>
          <button className="sidebar-settings" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /> 工作台设置</button>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div className="topbar-left"><button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开会话列表"><Menu size={20} /></button><span className="workspace-label">工作台</span><span className="topbar-separator">/</span><strong>{current ? current.title : '新对话'}</strong></div>
          <div className="topbar-right"><span className="mode-pill"><span className={`state-dot ${status ? '' : 'offline'}`} /> {status?.mode === 'live' ? '实时模型' : status ? '产品演示' : '服务离线'}</span><button className="icon-button inspector-toggle" onClick={() => setInspectorOpen(!inspectorOpen)} title="证据与流程" aria-label="证据与流程"><PanelRight size={19} /></button></div>
        </header>

        <div className="conversation-scroll" ref={scrollRef} onScroll={event => { const el = event.currentTarget; setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 180) }}>
          {!current?.messages.length ? <div className="welcome">
            <div className="welcome-kicker"><span className="kicker-line" /> MEDIX ASSISTANT <span className="kicker-line" /></div>
            <h1>今天想了解什么？</h1>
            <p>从健康问题出发，查看协作视角、参考知识和每一步处理过程。</p>
            <div className="prompt-grid">{prompts.map(({ icon: Icon, title, text }) => <button key={title} className="prompt-card" onClick={() => sendMessage(text)}>
              <span className="prompt-icon"><Icon size={21} /></span><span className="prompt-copy"><strong>{title}</strong><small>{text}</small></span><ArrowRight size={17} className="prompt-arrow" />
            </button>)}</div>
            <div className="welcome-note"><Info size={15} /><span>演示知识卡用于展示系统流程；不代替医师诊断。</span></div>
          </div> : <div className="message-list">
            <div className="thread-date">{formatTime(current.updated)} · 咨询记录</div>
            {current.messages.map(message => message.role === 'user' ? <div className="user-message" key={message.id}><div className="user-bubble">{message.image && <img className="message-image" src={message.image} alt="用户上传的医学影像" />}{message.content}</div><div className="user-avatar">我</div></div> : <div className="assistant-message" key={message.id}>
              <div className="assistant-avatar"><HeartPulse size={18} /></div><div className="assistant-body"><div className="assistant-meta"><strong>MediX Care</strong><span>{message.reply?.route === 'swarm' ? `${message.reply.agents.length} 个任务协作` : '健康问答'}</span>{message.reply && <span>{message.reply.elapsed_ms} ms</span>}</div>
                {message.reply?.high_risk && <div className="risk-banner"><AlertCircle size={17} /><span>此问题包含需优先关注的症状，请及时联系线下医疗服务。</span></div>}
                <div className="answer-content">{message.content.split(/(?=【[^】]+】)/).filter(Boolean).map((section, index) => {
                  const match = section.match(/^【([^】]+)】\n?([\s\S]*)$/)
                  return match ? <section key={index} className="answer-section"><h3>{match[1]}</h3><p>{safeMarkdown(match[2].trim())}</p></section> : <p key={index}>{safeMarkdown(section)}</p>
                })}</div>
                <div className="answer-footer"><button onClick={() => { setInspectorTab('evidence'); setInspectorOpen(true) }}><BookOpen size={15} /> {message.reply?.evidence.length || 0} 条参考</button><button onClick={() => { setInspectorTab('trace'); setInspectorOpen(true) }}><Activity size={15} /> 执行流程</button><span /><button className={message.feedback === 'up' ? 'chosen' : ''} onClick={() => setFeedback(message.id, 'up')} title="有帮助" aria-label="有帮助"><ThumbsUp size={15} /></button><button className={message.feedback === 'down' ? 'chosen' : ''} onClick={() => setFeedback(message.id, 'down')} title="需改进" aria-label="需改进"><ThumbsDown size={15} /></button></div>
              </div>
            </div>)}
            {busy && <div className="assistant-message pending"><div className="assistant-avatar"><HeartPulse size={18} /></div><div className="assistant-body"><div className="assistant-meta"><strong>MediX Care</strong><span>正在整理信息</span></div><div className="typing"><i /><i /><i /></div></div></div>}
            <div ref={bottomRef} />
          </div>}
        </div>
        {showJump && <button className="jump-bottom" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })} title="跳到最新消息"><ArrowDown size={17} /></button>}
        <div className="composer-wrap">
          {error && <div className="error-message"><AlertCircle size={16} />{error}<button onClick={() => setError('')} aria-label="关闭提示"><X size={15} /></button></div>}
          <div className="composer">
            {attachment && <div className="attachment-preview"><img src={attachment} alt="附件预览" /><span>{fileName}</span><button onClick={() => { setAttachment(null); setFileName('') }} aria-label="移除图片"><X size={14} /></button></div>}
            <textarea ref={textareaRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage() } }} placeholder="描述症状、询问健康知识，或上传影像…" aria-label="输入健康问题" rows={2} />
            <div className="composer-actions"><div className="composer-left"><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => { onFile(event.target.files?.[0]); event.currentTarget.value = '' }} /><button className="attachment-button" onClick={() => fileRef.current?.click()} title="添加影像"><ImagePlus size={18} /> <span>添加影像</span></button><span className="composer-hint">仅供健康信息参考</span></div><button className="send-button" onClick={() => sendMessage()} disabled={!draft.trim() || busy} aria-label="发送消息"><Send size={18} /></button></div>
          </div>
          <p className="composer-disclaimer">MediX Care 不提供诊断或处方。紧急情况请立即联系当地急救服务。</p>
        </div>
      </main>

      <aside className={`inspector ${inspectorOpen ? 'inspector-open' : ''}`}>
        <div className="inspector-head"><div><span className="inspector-overline">CASE CONTEXT</span><h2>证据与流程</h2></div><button className="icon-button inspector-close" onClick={() => setInspectorOpen(false)} aria-label="关闭信息面板"><X size={18} /></button></div>
        <div className="inspector-tabs"><button className={inspectorTab === 'evidence' ? 'active' : ''} onClick={() => setInspectorTab('evidence')}><BookOpen size={16} /> 参考知识</button><button className={inspectorTab === 'trace' ? 'active' : ''} onClick={() => setInspectorTab('trace')}><Activity size={16} /> 执行流程</button></div>
        {selectedReply ? <div className="inspector-content">
          <div className="case-summary"><div className="case-summary-top"><span className="summary-symbol"><Stethoscope size={19} /></span><span className="case-mode">{selectedReply.route === 'swarm' ? '多任务协作' : '单任务处理'}</span></div><strong>本轮协作概览</strong><p>{selectedReply.agents.join(' · ')}</p><div className="case-summary-bottom"><Clock3 size={14} /> {selectedReply.elapsed_ms} ms <span /> {selectedReply.mode === 'demo' ? '演示模式' : '实时模型'}</div></div>
          {inspectorTab === 'evidence' ? <><div className="panel-section-title">检索结果 <span>{selectedReply.evidence.length}</span></div>{selectedReply.evidence.map((card, index) => <div className="evidence-item" key={card.id}><div className="evidence-index">{String(index + 1).padStart(2, '0')}</div><div><div className="evidence-category">{card.category} · {card.source}</div><strong>{card.title}</strong><p>{card.excerpt}</p></div></div>)}<div className="panel-notice"><CircleHelp size={16} /><span>知识卡是演示资料，请核对原始来源及发布日期。</span></div></> : <><div className="panel-section-title">处理轨迹 <span>{selectedReply.trace.length} 步</span></div><div className="trace-list">{selectedReply.trace.map((step, index) => <div className="trace-step" key={index}><span className="trace-dot"><Check size={12} /></span><div><strong>{step.label}</strong><p>{step.detail}</p></div></div>)}</div><div className="panel-notice"><Activity size={16} /><span>每次请求都会重新路由并整理证据。</span></div></>}
        </div> : <div className="inspector-empty"><span><FileText size={24} /></span><h3>等待新的咨询</h3><p>发送问题后，这里会展示参考知识与处理轨迹。</p></div>}
        <div className="inspector-bottom"><ShieldCheck size={17} /><span>对话仅保留在本次浏览器会话；图片不持久化</span></div>
      </aside>

      {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}><div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}><div className="modal-head"><div><span>WORKSPACE SETTINGS</span><h2 id="settings-title">工作台设置</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭设置"><X size={19} /></button></div><div className="settings-row"><div><strong>运行模式</strong><p>由服务端环境配置决定；视觉能力：{status?.vision_enabled ? '已启用' : '未启用'}</p></div><span className="settings-value"><span className="state-dot" /> {status?.mode === 'live' ? '实时模型' : '产品演示'}</span></div><label className="settings-label" htmlFor="access-token">实时模型访问口令</label><input id="access-token" className="settings-input" type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="仅实时模式需要" /><p className="settings-help">口令只保存在本次浏览器会话，不会写入对话记录。实时模式会将输入发送给你配置的模型服务。</p><div className="modal-actions"><button onClick={() => setSettingsOpen(false)}>完成</button></div></div></div>}
    </div>
  )
}
