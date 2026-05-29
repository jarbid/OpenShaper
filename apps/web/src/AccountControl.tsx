import { useEntitlements, useSession } from '@board-studio/accounts';
import { Button } from '@board-studio/ui';

/**
 * Toolbar account control. Shows the signed-in user + sign-out, a Sign-in
 * action when auth is configured but signed out, or a muted "Local mode" label
 * when no Supabase project is wired up.
 */
export function AccountControl() {
  const { user, configured, loading, signInWithOtp, signOut } = useSession();
  const { tier } = useEntitlements();

  if (!configured) {
    return <span className="px-2 text-xs text-muted-foreground">Local mode · {tier}</span>;
  }
  if (loading) {
    return <span className="px-2 text-xs text-muted-foreground">…</span>;
  }

  if (!user) {
    return (
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          const email = window.prompt('Email for a sign-in link:');
          if (!email) return;
          const { error } = await signInWithOtp(email);
          alert(error ?? `Sign-in link sent to ${email}.`);
        }}
      >
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 px-1 text-xs">
      <span className="text-muted-foreground">
        {user.email} · {tier}
      </span>
      <Button size="sm" variant="ghost" onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}
