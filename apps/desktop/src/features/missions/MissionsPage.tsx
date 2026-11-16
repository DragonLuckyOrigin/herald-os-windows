import { t as uiT, useT as useUiT } from '../../store/i18n.ts'
import { useStore } from '@nanostores/react'
import { IconPlus, IconTarget } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, LinkAction, MoreButton, PageHeader, Section, Tabs, type TabDef } from '../../components/ui/glass.tsx'
import { $activeMissions, $activity, $completedMissions, $missionFocus, $reviewMissions } from '../../store/missions.ts'
import { ActivityTimeline } from './ActivityTimeline.tsx'
import { MissionCard } from './MissionCard.tsx'
import { MissionComposer } from './MissionComposer.tsx'
import { MissionDetail } from './MissionDetail.tsx'

type TabId = 'active' | 'review' | 'completed'

const ACTIVITY_SHORT = 6
const ACTIVITY_LONG = 20

const EMPTY_COPY: Record<TabId, { title: string; description: string }> = {
  active: { get title() { return uiT("ui.57d551c3c29a") }, get description() { return uiT("ui.e77550dc875b") } },
  review: { get title() { return uiT("ui.f9e120c45097") }, get description() { return uiT("ui.8763656f1f10") } },
  completed: { get title() { return uiT("ui.9d3a4e0caa24") }, get description() { return uiT("ui.520abbcb73f8") } }
}

export function MissionsPage() {
  useUiT()
  const active = useStore($activeMissions)
  const review = useStore($reviewMissions)
  const completed = useStore($completedMissions)
  const activity = useStore($activity)
  const [tab, setTab] = useState<TabId>('active')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showAllActivity, setShowAllActivity] = useState(false)
  const [composing, setComposing] = useState(false)

  // A command (voice, agent) asked for a tab, a mission or the composer: follow it.
  const focus = useStore($missionFocus)

  useEffect(() => {
    if (!focus) {
      return
    }

    if (focus.tab) {
      setTab(focus.tab === 'queued' ? 'active' : focus.tab)
    }

    if (focus.missionId) {
      setSelectedId(focus.missionId)
    }

    if (focus.compose) {
      setComposing(true)
    }
  }, [focus])

  const tabs: readonly TabDef<TabId>[] = [
    { id: 'active', label: uiT("ui.92340695899b"), count: active.length },
    { id: 'review', label: uiT("ui.07297fa94a99"), count: review.length },
    { id: 'completed', label: uiT("ui.22a970d2e5b1"), count: completed.length }
  ]
  const list = tab === 'active' ? active : tab === 'review' ? review : completed
  // Auto-select the first mission of the current tab when nothing (or something gone) is selected.
  const selected = list.find(m => m.id === selectedId) ?? list[0] ?? null
  const recent = activity.slice(0, showAllActivity ? ACTIVITY_LONG : ACTIVITY_SHORT)

  const changeTab = (next: TabId) => {
    setTab(next)
    setSelectedId(null)
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="missions"
        title={uiT("ui.93ffb8ce98c7")}
        subtitle={uiT("ui.88a017631b38")}
        actions={
          <>
            <GlassButton onClick={() => setComposing(true)} aria-label={uiT("ui.261276596ca7")}>
              <IconPlus />
              {uiT("ui.f47572556a86")}</GlassButton>
            <MoreButton />
          </>
        }
      />

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <Tabs tabs={tabs} value={tab} onChange={changeTab} className="self-start" />

          {list.length === 0 ? (
            <EmptyGlass
              icon={<IconTarget />}
              title={EMPTY_COPY[tab].title}
              description={EMPTY_COPY[tab].description}
              action={
                tab === 'active' ? (
                  <GlassButton size="sm" variant="primary" onClick={() => setComposing(true)}>
                    <IconPlus />
                    {uiT("ui.f47572556a86")}</GlassButton>
                ) : undefined
              }
            />
          ) : (
            <div className="stagger flex flex-col gap-3">
              {list.map(mission => (
                <MissionCard key={mission.id} mission={mission} selected={selected?.id === mission.id} onSelect={() => setSelectedId(mission.id)} />
              ))}
            </div>
          )}

          <Section
            title={uiT("ui.6cb44b56336a")}
            action={
              activity.length > ACTIVITY_SHORT ? (
                <LinkAction onClick={() => setShowAllActivity(v => !v)}>{showAllActivity ? uiT("ui.94ea9b1d33a0") : uiT("ui.30a64216eaea")}</LinkAction>
              ) : undefined
            }
          >
            <ActivityTimeline entries={recent} />
          </Section>
        </div>

        <div className="flex w-[420px] shrink-0 flex-col gap-3">
          {composing && <MissionComposer onClose={() => setComposing(false)} />}
          <GlassCard className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
            {selected ? (
              <MissionDetail key={selected.id} mission={selected} />
            ) : (
              <EmptyGlass icon={<IconTarget />} title={uiT("ui.e8dcdaa8dcfe")} description={uiT("ui.35c82a535c66")} className="flex-1" />
            )}
          </GlassCard>
        </div>
      </div>
    </div>
  )
}
