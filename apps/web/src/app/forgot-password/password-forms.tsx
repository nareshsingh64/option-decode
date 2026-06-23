"use client";

import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { FormEvent } from "react";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);
    setError(null);

    try {
      await requestPasswordReset(email);
      setMessage("If this email is registered, a password reset link has been sent.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to request password reset");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="grid w-full gap-4 rounded border border-white/15 bg-slate-950/78 p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-6" onSubmit={handleSubmit}>
      <div>
        <div className="mb-4 grid h-11 w-11 place-items-center rounded border border-emerald-300/50 bg-emerald-300/15 text-emerald-200">
          <Mail size={20} />
        </div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">Password reset</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Send reset link</h2>
      </div>

      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
        Email
        <input value={email} onChange={(event) => setEmail(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm normal-case text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" placeholder="name@example.com" type="email" required />
      </label>

      <button className="inline-flex h-11 items-center justify-center gap-2 rounded border border-emerald-400 bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting} type="submit">
        {isSubmitting ? "Sending..." : "Send reset link"}
        <ArrowRight size={16} />
      </button>

      {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
      {error ? <p className="text-sm text-red-300">{error}</p> : null}

      <a className="text-sm font-semibold text-emerald-300 transition hover:text-emerald-200" href="/login">
        Back to login
      </a>
    </form>
  );
}

export function ResetPasswordFormShell() {
  return (
    <Suspense fallback={<ResetCard title="Checking reset link" detail="Preparing password reset..." />}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(token ? null : "Reset token is missing.");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setMessage(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      setIsSubmitting(false);
      return;
    }

    try {
      await resetPassword(token, password);
      setMessage("Password has been reset. Redirecting to the app...");
      router.replace("/app?view=dashboard");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Unable to reset password");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="grid w-full gap-4 rounded border border-white/15 bg-slate-950/78 p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-6" onSubmit={handleSubmit}>
      <div>
        <div className="mb-4 grid h-11 w-11 place-items-center rounded border border-emerald-300/50 bg-emerald-300/15 text-emerald-200">
          <ShieldCheck size={20} />
        </div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">Choose new password</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Reset password</h2>
      </div>

      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
        New password
        <input value={password} onChange={(event) => setPassword(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" minLength={8} placeholder="Minimum 8 characters" type="password" required />
      </label>

      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
        Confirm password
        <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" minLength={8} placeholder="Repeat new password" type="password" required />
      </label>

      <button className="inline-flex h-11 items-center justify-center gap-2 rounded border border-emerald-400 bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting || !token} type="submit">
        {isSubmitting ? "Updating..." : "Reset password"}
        <ArrowRight size={16} />
      </button>

      {message ? <p className="text-sm text-emerald-300">{message}</p> : null}
      {error ? <p className="text-sm text-red-300">{error}</p> : null}
    </form>
  );
}

function ResetCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="grid w-full gap-2 rounded border border-white/15 bg-slate-950/78 p-5 text-white shadow-2xl shadow-black/30 backdrop-blur md:p-6">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="text-sm text-slate-300">{detail}</p>
    </div>
  );
}

async function requestPasswordReset(email: string) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ email })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Password reset request failed with HTTP ${response.status}`);
  }
}

async function resetPassword(token: string, password: string) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/reset-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ token, password })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Password reset failed with HTTP ${response.status}`);
  }
}

export function VerifyEmailFormShell() {
  return (
    <Suspense fallback={<ResetCard title="Verifying email" detail="Checking your verification link..." />}>
      <VerifyEmailForm />
    </Suspense>
  );
}

function VerifyEmailForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [message, setMessage] = useState("Checking your verification link...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function verify() {
      if (!token) {
        setError("Verification token is missing.");
        setMessage("");
        return;
      }

      try {
        await verifyEmail(token);
        if (!isMounted) {
          return;
        }
        setMessage("Email verified. Redirecting to the app...");
        router.replace("/app?view=account");
      } catch (verifyError) {
        if (!isMounted) {
          return;
        }
        setError(verifyError instanceof Error ? verifyError.message : "Unable to verify email");
        setMessage("");
      }
    }

    void verify();
    return () => {
      isMounted = false;
    };
  }, [router, token]);

  return <ResetCard title={error ? "Verification failed" : "Email verification"} detail={error ?? message} />;
}

async function verifyEmail(token: string) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({ token })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Email verification failed with HTTP ${response.status}`);
  }
}
