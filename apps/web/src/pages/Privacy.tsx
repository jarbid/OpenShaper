import { useSyncExternalStore } from 'react';
import { Button } from '@openshaper/ui';
import { ArticleHero, Container, CtaBand } from '../components/content';
import { Seo } from '../seo/Seo';
import { getConsent, setConsent, subscribeConsent } from '../consent';
import { downgradeFromFullTracking, upgradeToFullTracking } from '../analytics';

function TrackingControls() {
  const consent = useSyncExternalStore(subscribeConsent, getConsent, () => null);

  const accept = () => {
    setConsent('accepted');
    upgradeToFullTracking();
  };

  // Autocapture's DOM listeners have no clean live "detach" once attached, so
  // turning full tracking back off reloads the page — the next load's
  // initAnalytics() reads the new (rejected) consent and never attaches them.
  const turnOff = () => {
    downgradeFromFullTracking();
    setConsent('rejected');
    window.location.reload();
  };

  return (
    <aside className="reveal mt-8 rounded-2xl border border-border bg-card p-7 sm:p-8">
      <h2 className="font-display text-2xl sm:text-3xl">Your choice</h2>
      <p className="mt-3 max-w-xl text-muted-foreground">
        {consent === 'accepted' &&
          "Full tracking is on for this browser — thank you. You can turn it off any time; we'll go back to the anonymous baseline above."}
        {consent === 'rejected' &&
          "You're on the anonymous baseline only. You can switch to full tracking any time — it takes effect immediately, no reload needed."}
        {consent === null &&
          "You haven't made a choice yet — you're on the anonymous baseline until you do."}
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        {consent !== 'accepted' && <Button onClick={accept}>Accept full tracking</Button>}
        {consent === 'accepted' && (
          <Button variant="outline" onClick={turnOff}>
            Turn off full tracking
          </Button>
        )}
      </div>
    </aside>
  );
}

export default function Privacy() {
  return (
    <>
      <Seo
        title="Privacy & analytics"
        path="/privacy"
        description="What OpenShaper tracks, why, and how to change your choice — anonymous by default, full tracking only with your consent."
      />

      <ArticleHero
        eyebrow="Privacy"
        title="What we track, and why."
        lede="Anonymous by default, with fuller tracking only if you accept. Here is exactly what each mode collects, and how to change your choice at any time."
      />

      <Container className="py-14">
        <div className="prose-shaper reveal">
          <h2>Anonymous by default</h2>
          <p>
            Every visitor starts here, and it never changes unless you say so. Nothing is stored in
            your browser — no cookies, no localStorage, no id following you around. To count visits
            without storing anything, our analytics provider works out a temporary identifier on its
            own servers; it resets daily and can&apos;t be traced back to you. We only see: anonymous
            pageviews, three feature-usage events (loading a starter template, saving, and exporting
            a board), and lightweight UX health signals (page load speed, rapid frustrated clicks,
            clicks on things that don&apos;t respond). It never leaves this anonymous mode on its
            own.
          </p>

          <h2>Full tracking, only if you accept</h2>
          <p>
            If you accept via the banner (or the button below), your browser gets a persistent id
            (a cookie, so we can recognize you across visits), full click/interaction tracking, and
            session replay so we can see how people actually use the editor. This is genuinely more
            data — worth being upfront about. Session replay masks form input values by default; a
            few known plain-text fields (like an imported file&apos;s name) are masked explicitly
            too.
          </p>
          <p>
            Accepting is also the only way you&apos;ll ever be asked a question here — an occasional
            short in-app survey, like what you&apos;re building or what&apos;s missing. There are
            no accounts, so an in-app survey is the only way to ask. Answers are yours to give:
            every survey can be dismissed, and dismissing one doesn&apos;t bring it back.
          </p>

          <h2>Rejecting is a real choice</h2>
          <p>
            Reject and full tracking simply never turns on — you stay on the anonymous baseline
            above, indefinitely. It doesn&apos;t disable analytics entirely; the anonymous, aggregate
            counts keep going, the same as if you hadn&apos;t decided yet.
          </p>

          <h2>Do Not Track</h2>
          <p>
            If your browser sends a Do Not Track signal, we honor it outright — it overrides
            everything above, including the anonymous baseline.
          </p>
        </div>

        <TrackingControls />
      </Container>

      <CtaBand
        heading="Build your own board"
        body="Open the app and start shaping — then take it to foam, foil or timber."
      />
      <div className="h-20" />
    </>
  );
}
