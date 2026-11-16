import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconArrowRight, IconCheck, IconGift, IconLock, IconUser, IconWifi } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { HeraldLogo } from '../../components/herald-logo.tsx'
import { GlassButton, GlassCard, LinkAction } from '../../components/ui/glass.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { $hermesAuth, refreshHermesAuth, requestHermesLogin } from '../../store/hermes-auth.ts'
import { $providerFocus, providerName } from '../../store/model-provider.ts'
import { ModelProviderRow } from '../settings/sections/ProviderRow.tsx'
import { StatusPanel } from '../status/StatusPanel.tsx'

type Step = 'welcome' | 'account' | 'wifi' | 'hermes' | 'done'

/**
 * First-boot setup on the Herald OS image: who the computer is for, their name and password,
 * Wi-Fi, and Hermes's sign-in. Setting it up for someone else skips the account and leaves setup
 * waiting for them at the next start.
 */
export function FirstRunSetup() {
  useUiT()
  const [due, setDue] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [step, setStep] = useState<Step>('welcome')
  const [forSomeoneElse, setForSomeoneElse] = useState(false)
  // Kept here: the Hermes step unmounts while the sign-in card is up.
  const [otherProvider, setOtherProvider] = useState(false)
  const auth = useStore($hermesAuth)
  const providerFocus = useStore($providerFocus)

  useEffect(() => {
    void window.heraldOS.setup
      ?.state()
      .then(state => {
        setDue(state.needed)
        setSignedIn(state.signedIn)
      })
      .catch(() => undefined)
  }, [])

  // The sign-in card's "Use another provider" lands on the Hermes step while setup is up.
  useEffect(() => {
    if (providerFocus) {
      setOtherProvider(true)
    }
  }, [providerFocus])

  if (!due) {
    return null
  }

  // Signing in happens on Hermes's own card; setup steps aside until it is done.
  if (step === 'hermes' && auth.needsLogin) {
    return null
  }

  const finish = async () => {
    await window.heraldOS.setup.finish({ later: forSomeoneElse })
    setDue(false)
  }

  const steps: Step[] = forSomeoneElse ? ['welcome', 'wifi', 'done'] : ['welcome', 'account', 'wifi', 'hermes', 'done']
  const next = () => setStep(steps[Math.min(steps.length - 1, steps.indexOf(step) + 1)] ?? 'done')

  return (
    <div className="absolute inset-0 z-(--z-boot) flex items-center justify-center bg-bg/85 backdrop-blur-md animate-fade-in" role="dialog" aria-label={uiT("ui.a2602f5404d5")}>
      <div className="float flex w-[min(560px,92vw)] flex-col gap-5 rounded-2xl p-7">
        <div className="flex items-center gap-3">
          <HeraldLogo height={22} />
          <span className="flex-1" />
          <div className="flex gap-1.5" aria-hidden>
            {steps.map(item => (
              <span key={item} className={cn('h-1.5 w-6 rounded-full bg-white/15', steps.indexOf(item) <= steps.indexOf(step) && 'bg-accent-strong')} />
            ))}
          </div>
        </div>

        {step === 'welcome' && (
          <Welcome
            signedIn={signedIn}
            onChoose={someoneElse => {
              setForSomeoneElse(someoneElse)
              setStep(someoneElse ? 'wifi' : 'account')
            }}
          />
        )}
        {step === 'account' && <Account onDone={next} signedIn={signedIn} />}
        {step === 'wifi' && (
          <div className="flex flex-col gap-4">
            <Heading icon={<IconWifi size={18} />} title={uiT("ui.e66096580f78")} text={uiT("ui.f2b7e0df8323")} />
            <div className="max-h-[320px] overflow-y-auto rounded-xl">
              <StatusPanel panel="wifi" />
            </div>
            <Footer onNext={next} label={uiT("ui.1ff57a29d7c9")} />
          </div>
        )}
        {step === 'hermes' && <HermesStep onDone={next} choosing={otherProvider} onChoose={() => setOtherProvider(true)} />}
        {step === 'done' && (
          <div className="flex flex-col gap-4">
            <Heading
              icon={forSomeoneElse ? <IconGift size={18} /> : <IconCheck size={18} />}
              title={forSomeoneElse ? uiT("ui.d071150b5bfa") : uiT("ui.f74981a0b378")}
              text={forSomeoneElse ? uiT("ui.b65bb8ea9cbc") : uiT("ui.3713ccf998f1")}
            />
            <Footer onNext={() => void finish()} label={forSomeoneElse ? uiT("ui.11a6767d5674") : uiT("ui.9a41e28cab8d")} />
          </div>
        )}
      </div>
    </div>
  )
}

function Heading({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  useUiT()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-fg">
        <span className="icon-tile size-8 rounded-lg">{icon}</span>
        <h2 className="text-[19px] font-semibold tracking-tight">{title}</h2>
      </div>
      <p className="text-[13px] leading-relaxed text-fg-3">{text}</p>
    </div>
  )
}

function Footer({ onNext, label, busy, disabled }: { onNext: () => void; label: string; busy?: boolean; disabled?: boolean }) {
  useUiT()
  return (
    <div className="flex justify-end">
      <GlassButton variant="primary" onClick={onNext} disabled={busy || disabled}>
        {busy ? <Spinner /> : null} {label} <IconArrowRight size={15} />
      </GlassButton>
    </div>
  )
}

function Welcome({ onChoose, signedIn }: { onChoose: (someoneElse: boolean) => void; signedIn: boolean }) {
  useUiT()
  return (
    <div className="flex flex-col gap-4">
      <Heading icon={<IconUser size={18} />} title={uiT("ui.cbea330c5d10")} text={uiT("ui.56f0be6f6ab9")} />
      <div className="grid grid-cols-2 gap-3">
        <button type="button" onClick={() => onChoose(false)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{uiT("ui.b755212e94fa")}</span>
          <span className="text-[12px] text-fg-3">{signedIn ? uiT("ui.3c7beae288dc") : uiT("ui.e5111757afd9")}</span>
        </button>
        <button type="button" onClick={() => onChoose(true)} className="glass-input flex flex-col items-start gap-1 rounded-xl p-4 text-left hover:border-line-strong">
          <span className="text-[14px] font-medium text-fg">{uiT("ui.b97c005a6ec5")}</span>
          <span className="text-[12px] text-fg-3">{uiT("ui.42a5485d04fd")}</span>
        </button>
      </div>
    </div>
  )
}

/** The name, and the password unless the account signed in at a login screen with one of its own. */
function Account({ onDone, signedIn }: { onDone: () => void; signedIn: boolean }) {
  useUiT()
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mismatch = again.length > 0 && password !== again

  const save = async () => {
    setBusy(true)
    setError(null)

    try {
      await window.heraldOS.setup.name(name)
      const result = signedIn ? { ok: true } : await window.heraldOS.setup.password(password)

      if (result.ok) {
        onDone()
      } else {
        setError(result.error ?? 'The password was not set.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        void save()
      }}
    >
      <Heading
        icon={<IconLock size={18} />}
        title={signedIn ? uiT("ui.2c6b2e253c01") : uiT("ui.d56ea258201d")}
        text={
          signedIn
            ? uiT("ui.3af404a58af6")
            : uiT("ui.353f1747258c")
        }
      />
      <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
        {uiT("ui.d297e206e6d4")}<input value={name} onChange={event => setName(event.target.value)} autoFocus autoComplete="name" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
      </label>
      {!signedIn && (
        <>
          <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
            {uiT("ui.d239bf7495c7")}<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-fg-3">
            {uiT("ui.6517779e051e")}<input type="password" value={again} onChange={event => setAgain(event.target.value)} autoComplete="new-password" className="glass-input h-10 rounded-lg px-3 text-[14px] text-fg outline-none" />
          </label>
        </>
      )}
      {(error || mismatch) && <p className="text-[12.5px] text-danger">{mismatch ? uiT("ui.f694aaa8da2c") : error}</p>}
      <Footer onNext={() => void save()} label={uiT("ui.1ff57a29d7c9")} busy={busy} disabled={!name.trim() || (!signedIn && (password.length < 8 || password !== again))} />
    </form>
  )
}

/** Hermes's model provider: sign in to the default one, or choose another (an account or an API key). */
function HermesStep({ onDone, choosing, onChoose }: { onDone: () => void; choosing: boolean; onChoose: () => void }) {
  useUiT()
  const auth = useStore($hermesAuth)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    void refreshHermesAuth().finally(() => setChecking(false))
  }, [])

  const signedIn = auth.checked && !auth.needsLogin && Boolean(auth.activeProvider)

  return (
    <div className="flex flex-col gap-4">
      <Heading
        icon={<IconUser size={18} />}
        title={uiT("ui.6109f6900932")}
        text={
          signedIn
            ? uiT("ui.d13711b9fd70", { value1: String(providerName(auth.activeProvider) ?? auth.activeProvider) })
            : uiT("ui.90a9ec56d21c")
        }
      />
      {choosing && (
        <GlassCard className="flex flex-col">
          <ModelProviderRow />
        </GlassCard>
      )}
      <div className="flex items-center justify-end gap-2">
        {!choosing && (
          <LinkAction className="mr-auto" onClick={onChoose}>
            {uiT("ui.800a32a2811b")}</LinkAction>
        )}
        {!signedIn && (
          <GlassButton variant="ghost" onClick={onDone}>
            {uiT("ui.aac6d6e13abe")}</GlassButton>
        )}
        {signedIn ? (
          <Footer onNext={onDone} label={uiT("ui.1ff57a29d7c9")} />
        ) : (
          !choosing && (
            <GlassButton variant="primary" onClick={() => requestHermesLogin('setup')} disabled={checking}>
              {checking ? <Spinner /> : null}{uiT("ui.5e1955a5b805")}<IconArrowRight size={15} />
            </GlassButton>
          )
        )}
      </div>
    </div>
  )
}
