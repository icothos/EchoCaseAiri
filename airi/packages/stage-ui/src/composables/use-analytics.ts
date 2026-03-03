import { useSharedAnalyticsStore } from '../stores/analytics'

export function useAnalytics() {
  const analyticsStore = useSharedAnalyticsStore()

  function trackProviderClick(_providerId: string, _module: string) {
    // Analytics removed
  }

  function trackFirstMessage() {
    // Only track the first message once
    if (analyticsStore.firstMessageTracked)
      return

    analyticsStore.markFirstMessageTracked()

    // const timeToFirstMessageMs = analyticsStore.appStartTime
    //   ? Date.now() - analyticsStore.appStartTime
    //   : null

    // Analytics removed
  }

  return {
    trackProviderClick,
    trackFirstMessage,
  }
}
