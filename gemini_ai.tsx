import { Index, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { useThrottleFn } from 'solidjs-use'
import { generateSignature } from '@/utils/auth'
import IconClear from './icons/Clear'
import IconX from './icons/X'
import Picture from './icons/Picture'
import MessageItem from './MessageItem'
import ErrorMessageItem from './ErrorMessageItem'
import type { ChatMessage, ErrorMessage } from '@/types'
import { predictUserInput } from '@/utils/ai' // Import AI prediction utility

export default () => {
  let inputRef: HTMLTextAreaElement
  const [messageList, setMessageList] = createSignal<ChatMessage[]>([])
  const [currentError, setCurrentError] = createSignal<ErrorMessage>()
  const [currentAssistantMessage, setCurrentAssistantMessage] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [controller, setController] = createSignal<AbortController | null>(null)
  const [isStick, setStick] = createSignal(false)
  const [showComingSoon, setShowComingSoon] = createSignal(false)
  const [suggestedInput, setSuggestedInput] = createSignal<string>('') // AI suggestion feature
  const maxHistoryMessages = parseInt(import.meta.env.PUBLIC_MAX_HISTORY_MESSAGES || '99', 10)

  createEffect(() => {
    if (isStick()) smoothToBottom()
  })

  onMount(() => {
    let lastPosition = window.scrollY

    const handleScroll = () => {
      const nowPosition = window.scrollY
      if (nowPosition < lastPosition) setStick(false)
      lastPosition = nowPosition
    }

    window.addEventListener('scroll', handleScroll)

    try {
      const savedMessages = localStorage.getItem('messageList')
      if (savedMessages) setMessageList(JSON.parse(savedMessages))

      const stickToBottom = localStorage.getItem('stickToBottom')
      if (stickToBottom === 'stick') setStick(true)
    } catch (err) {
      console.error(err)
    }

    const handleBeforeUnload = () => {
      localStorage.setItem('messageList', JSON.stringify(messageList()))
      if (isStick()) {
        localStorage.setItem('stickToBottom', 'stick')
      } else {
        localStorage.removeItem('stickToBottom')
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    onCleanup(() => {
      window.removeEventListener('scroll', handleScroll)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    })
  })

  const handleButtonClick = async () => {
    const inputValue = inputRef.value
    if (!inputValue) return

    inputRef.value = ''
    setMessageList([...messageList(), { role: 'user', content: inputValue }])
    await requestWithLatestMessage()
    instantToBottom()
  }

  const smoothToBottom = useThrottleFn(() => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
  }, 300)

  const instantToBottom = () => {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
  }

  const convertReqMsgList = (originalMsgList: ChatMessage[]) => {
    return originalMsgList.filter((curMsg, i, arr) => {
      const nextMsg = arr[i + 1]
      return !nextMsg || curMsg.role !== nextMsg.role
    })
  }

  const requestWithLatestMessage = async () => {
    setLoading(true)
    setCurrentAssistantMessage('')
    setCurrentError(null)
    const storagePassword = localStorage.getItem('pass')
    try {
      const abortCtrl = new AbortController()
      setController(abortCtrl)
      const requestMessageList = messageList().map(message => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      })).slice(-maxHistoryMessages)
      const timestamp = Date.now()
      const response = await fetch('/api/generate', {
        method: 'POST',
        body: JSON.stringify({
          messages: convertReqMsgList(requestMessageList),
          time: timestamp,
          pass: storagePassword,
          sign: await generateSignature({
            t: timestamp,
            m: requestMessageList[requestMessageList.length - 1]?.parts[0]?.text || '',
          }),
        }),
        signal: abortCtrl.signal,
      })
      if (!response.ok) {
        const error = await response.json()
        console.error(error.error)
        setCurrentError(error.error)
        throw new Error('Request failed')
      }
      const data = response.body
      if (!data) throw new Error('No data')

      const reader = data.getReader()
      const decoder = new TextDecoder('utf-8')
      let done = false

      while (!done) {
        const { value, done: readerDone } = await reader.read()
        if (value) {
          const char = decoder.decode(value, { stream: true })
          if (char === '\n' && currentAssistantMessage().endsWith('\n')) continue

          if (char) setCurrentAssistantMessage(currentAssistantMessage() + char)
          if (isStick()) instantToBottom()
        }
        done = readerDone
      }
      if (done) setCurrentAssistantMessage(currentAssistantMessage() + decoder.decode())
    } catch (e) {
      console.error(e)
      setLoading(false)
      setController(null)
    }
    archiveCurrentMessage()
    if (isStick()) instantToBottom()
  }

  const archiveCurrentMessage = () => {
    if (currentAssistantMessage()) {
      setMessageList([...messageList(), { role: 'assistant', content: currentAssistantMessage() }])
      setCurrentAssistantMessage('')
      setLoading(false)
      setController(null)
      if (!('ontouchstart' in document.documentElement || navigator.maxTouchPoints > 0))
        inputRef.focus()
    }
  }

  const clear = () => {
    inputRef.value = ''
    inputRef.style.height = 'auto'
    setMessageList([])
    setCurrentAssistantMessage('')
    setCurrentError(null)
  }

  const stopStreamFetch = () => {
    if (controller()) {
      controller().abort()
      archiveCurrentMessage()
    }
  }

  const retryLastFetch = () => {
    if (messageList().length > 0) {
      const lastMessage = messageList()[messageList().length - 1]
      if (lastMessage.role === 'assistant')
        setMessageList(messageList().slice(0, -1))
      requestWithLatestMessage()
    }
  }

  const handleKeydown = async (e: KeyboardEvent) => {
    if (e.isComposing || e.shiftKey) return

    if (e.key === 'Enter') {
      e.preventDefault()
      handleButtonClick()
    }
  }

  const handlePictureUpload = () => {
    setShowComingSoon(true)
  }

  // AI-based input prediction
  const handleInputChange = async () => {
    const inputValue = inputRef.value
    if (inputValue) {
      const prediction = await predictUserInput(inputValue)
      setSuggestedInput(prediction)
    } else {
      setSuggestedInput('')
    }
  }

  return (
    <div my-6>
      <Show when={showComingSoon()}>
        <div class="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-100">
          <div class="bg-white rounded-md shadow-md p-6">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-medium">Coming soon</h3>
              <button onClick={() => setShowComingSoon(false)}>
                <IconX />
              </button>
            </div>
            <p class="text-gray-500 mt-2">Chat with picture is coming soon!</p>
          </div>
        </div>
      </Show>

      <Index each={messageList()}>
        {(message, index) => (
          <MessageItem
            role={message().role}
            message={message().content}
            showRetry={() => (message().role === 'assistant' && index() === messageList().length - 1)}
            onRetry={retryLastFetch}
          />
        )}
      </Index>
      {currentAssistantMessage() && (
        <MessageItem
          role="assistant"
          message={currentAssistantMessage()}
        />
      )}
      {currentError() && <ErrorMessageItem data={currentError()} onRetry={retryLastFetch} />}
      <Show
        when={!loading()}
        fallback={() => (
          <div class="gen-cb-wrapper">
            <span>AI is thinking...</span>
            <div class="gen-cb-stop" onClick={stopStreamFetch}>Stop</div>
          </div>
        )}
      >
        <div class="gen-text-wrapper relative">
          <button title="Picture" onClick={handlePictureUpload} class="absolute left-1rem top-50% translate-y-[-50%]">
            <Picture />
          </button>
          <textarea
            ref={inputRef!}
            onKeyDown={handleKeydown}
            onInput={handleInputChange} // Added AI prediction
            placeholder="Enter something..."
            autocomplete="off"
            autofocus
            onInput={() => {
              inputRef.style.height = 'auto'
              inputRef.style.height = `${inputRef.scrollHeight}px`
            }}
            rows="1"
            class="gen-textarea"
          />
          <button onClick={handleButtonClick} gen-slate-btn>
            Send
          </button>
          <button title="Clear" onClick={clear} gen-slate-btn>
            <IconClear />
          </button>
        </div>
      </Show>
      <Show when={suggestedInput()}>
        <div class="suggestion">
          <p>Suggested: {suggestedInput()}</p>
          <button onClick={() => inputRef.value = suggestedInput()}>Use Suggestion</button>
        </div>
      </Show>
    </div>
  )
}

