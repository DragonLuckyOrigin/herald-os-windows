import { useStore } from '@nanostores/react'
import { IconCalendarStats, IconChartBar, IconCoin, IconCreditCard, IconGauge, IconLayoutNavbar, IconRefresh } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { GlassButton, ProgressBar, Toggle } from '../../../components/ui/glass.tsx'
import { formatDollars, formatTokens, planPercent, type UsageSummary } from '../../../lib/usage.ts'
import { $prefs, updatePrefs } from '../../../store/backend.ts'
import { $usage, loadUsage } from '../../../store/usage.ts'
import { openWebWindow } from '../../../store/web-windows.ts'
import { t, useT } from '../../../store/i18n.ts'
import { errorText, InlineNote, markSaved, SectionTitle, SettingsGroup, SettingsRow } from './shared.tsx'

/*
 * What Hermes has used: the provider plan's limits (Nous Portal reports them through `usage.bars`
 * and `billing.state`) and Hermes's own token accounting per session (`/api/analytics/usage`).
 */

export function UsageSection() {
  const t = useT()
  const usage = useStore($usage)
  const prefs = useStore($prefs)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)

    try {
      await loadUsage()
      setError(null)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const plan = usage?.plan
  const billing = usage?.billing
  const pct = planPercent(plan)

  return (
    <>
      <SectionTitle title={t('settings.section.usage')} subtitle={t('settings.usage.subtitle')} />

      <SettingsGroup title={t("settings.detail.plan.fa8ed")}>
        {plan?.available ? (
          <>
            <SettingsRow
              icon={<IconGauge />}
              label={plan.plan_name || t("settings.detail.yourPlan.d9ab7")}
              description={[plan.plan_bar ? t("settings.detail.ofUsed.1fde6", { value1: plan.plan_bar.spent_display, value2: plan.plan_bar.total_display }) : null, plan.renews_display ? t("settings.detail.renews.48aad", { value1: plan.renews_display }) : null].filter(Boolean).join(' · ') || undefined}
              keywords="limit quota subscription plan"
              below={plan.plan_bar ? <ProgressBar value={Math.round(pct ?? 0)} tone={pct !== null && pct >= 90 ? 'progress' : 'accent'} /> : undefined}
            >
              {pct !== null && <span className="text-[13px] font-medium tabular-nums text-fg">{Math.round(pct)}%</span>}
            </SettingsRow>
            {plan.topup_bar && (
              // A fuel gauge: `fill_fraction` is the share still left.
              <SettingsRow icon={<IconCoin />} label={t("settings.detail.topupCredit.96f7c")} description={t("settings.detail.leftOf.ecb19", { value1: plan.topup_bar.remaining_display, value2: plan.topup_bar.total_display })} keywords="credit topup balance" below={<ProgressBar value={Math.round((plan.topup_bar.fill_fraction ?? 0) * 100)} tone="ok" />} />
            )}
          </>
        ) : (
          <SettingsRow
            icon={<IconGauge />}
            label={t("settings.detail.planLimits.92578")}
            description={billing?.logged_in ? t("settings.detail.yourProviderDoesNotReportPlanLimits.a3c5a") : t("settings.detail.planLimitsAppearHereWhenHermesIsSigned.13083")}
            keywords="limit quota subscription plan"
          />
        )}
        {billing?.logged_in && (billing.balance_display || billing.monthly_cap) && (
          <SettingsRow
            icon={<IconCreditCard />}
            label={billing.org_name || t('settings.detail.billing.3ac8b')}
            description={[billing.balance_display ? t("settings.detail.balance.0f0f7", { value1: billing.balance_display }) : null, billing.monthly_cap ? t("settings.detail.ofThisMonth.638d9", { value1: billing.monthly_cap.spent_display, value2: billing.monthly_cap.limit_display }) : null].filter(Boolean).join(' · ')}
            keywords="billing balance spend cap"
          >
            {billing.portal_url && (
              <GlassButton size="sm" onClick={() => void openWebWindow(billing.portal_url as string, { title: t("settings.detail.billing.3ac8b") })}>
                {t("settings.detail.manage.5a234")}</GlassButton>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>

      <UsagePeriod title={t("settings.detail.thisWeek.8c4ee")} icon={<IconChartBar />} summary={usage?.week ?? null} />
      <UsagePeriod title={t("settings.detail.last30Days.f8f03")} icon={<IconCalendarStats />} summary={usage?.month ?? null} />

      <SettingsGroup title={t("settings.detail.menuBar.2d9de")}>
        <SettingsRow icon={<IconLayoutNavbar />} label={t("settings.detail.showPlanUsageInTheMenuBar.ae0a8")} description={t("settings.detail.aSmallMeterNextToTheClockWhile.3754e")} keywords="menu bar meter percent">
          <Toggle checked={Boolean(prefs.usageInMenuBar)} onChange={next => void updatePrefs({ usageInMenuBar: next }).then(markSaved)} label={t("settings.detail.showPlanUsageInTheMenuBar.ae0a8")} />
        </SettingsRow>
      </SettingsGroup>

      <div className="flex items-center justify-between gap-3">
        {error ? <InlineNote tone="danger">{error}</InlineNote> : <span className="text-[11.5px] text-fg-4">{usage ? t("settings.detail.updated.58223", { value1: new Date(usage.loadedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : ''}</span>}
        <GlassButton size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          <IconRefresh />
          {loading ? t("settings.detail.refreshing.1c0de") : t('settings.detail.refresh.0e916')}
        </GlassButton>
      </div>
    </>
  )
}

function UsagePeriod({ title, icon, summary }: { title: string; icon: React.ReactNode; summary: UsageSummary | null }) {
  useT()
  if (!summary) {
    return null
  }

  const peak = Math.max(1, ...summary.daily.map(day => day.tokens))

  return (
    <SettingsGroup title={title}>
      <SettingsRow
        icon={icon}
        label={t("settings.detail.tokens.0d0ab", { value1: formatTokens(summary.tokens) })}
        description={[t('settings.usage.sessions', { count: summary.sessions }), summary.cost > 0 ? t("settings.detail.about.6d84d", { value1: formatDollars(summary.cost) }) : null, summary.topModel ? t("settings.detail.mostly.6b7b0", { value1: summary.topModel }) : null].filter(Boolean).join(' · ')}
        keywords="tokens sessions cost model"
        below={
          summary.daily.length > 1 ? (
            <div className="flex h-10 items-end gap-1" aria-label={t("settings.detail.tokensPerDay.9f55d", { value1: title })}>
              {summary.daily.slice(-30).map(day => (
                <span key={day.day} title={t("settings.detail.tokens.fe9ca", { value1: day.day, value2: formatTokens(day.tokens) })} className="min-w-1 flex-1 rounded-t-sm bg-accent/60" style={{ height: `${Math.max(4, (day.tokens / peak) * 100)}%` }} />
              ))}
            </div>
          ) : undefined
        }
      >
        <span className="text-[12px] tabular-nums text-fg-3">
          {formatTokens(summary.input)} {t("settings.detail.in.81e7b")} {formatTokens(summary.output)} {t("settings.detail.out.76206")}</span>
      </SettingsRow>
    </SettingsGroup>
  )
}
