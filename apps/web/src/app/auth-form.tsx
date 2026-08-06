"use client";

import { ArrowRight, LockKeyhole, MailCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";

type AuthMode = "login" | "register";

interface AuthFormProps {
  mode: AuthMode;
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set after a successful registration. Registration no longer signs anyone
  // in, so there is nowhere to redirect to - the form is replaced by the
  // instruction to go and verify.
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isRegister = mode === "register";

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      await submitAuth(mode, {
        email,
        password,
        displayName,
        mobile
      });
      if (isRegister) {
        setRegisteredEmail(email.trim());
        return;
      }
      router.replace("/app?view=dashboard");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Unable to complete account request");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (registeredEmail) {
    return (
      <div className="grid gap-4 rounded border border-white/15 bg-slate-950/78 p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-6">
        <div className="grid h-11 w-11 place-items-center rounded border border-emerald-300/50 bg-emerald-300/15 text-emerald-200">
          <MailCheck size={20} />
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">Almost there</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Verify your email</h1>
        </div>
        <p className="text-sm leading-6 text-slate-300">
          We sent a verification link to <span className="font-semibold text-white">{registeredEmail}</span>. Open it to activate your
          account, then sign in. The link is valid for 24 hours.
        </p>
        <p className="text-sm leading-6 text-slate-400">
          Nothing arrived? Check your spam folder, or contact{" "}
          <a className="font-semibold text-emerald-300" href="mailto:support@pytrade.co.in">
            support@pytrade.co.in
          </a>
          .
        </p>
        <a
          className="inline-flex h-11 items-center justify-center gap-2 rounded border border-emerald-400 bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:opacity-90"
          href="/login"
        >
          Go to login
          <ArrowRight size={16} />
        </a>
      </div>
    );
  }

  return (
    <form className="grid gap-4 rounded border border-white/15 bg-slate-950/78 p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-6" onSubmit={handleSubmit}>
      <div>
        <div className="mb-4 grid h-11 w-11 place-items-center rounded border border-emerald-300/50 bg-emerald-300/15 text-emerald-200">
          <LockKeyhole size={20} />
        </div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">{isRegister ? "Start your trial" : "Welcome back"}</p>
        <h1 className="mt-2 text-3xl font-semibold text-white">{isRegister ? "Create account" : "Login to Option Decode"}</h1>
      </div>

      {isRegister ? (
        <>
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
            Name
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm normal-case text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" maxLength={80} placeholder="Your name" required />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
            Mobile
            <input
              value={mobile}
              onChange={(event) => setMobile(event.target.value)}
              className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm normal-case text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300"
              inputMode="tel"
              // Matches the server's rule (registerSchema): an Indian mobile,
              // optionally +91-prefixed, with spaces/dashes tolerated. Kept
              // permissive here and normalised server-side rather than
              // fighting the user over formatting.
              pattern="^\s*(\+?91)?[\s-]*[6-9][0-9\s-]{9,}$"
              placeholder="9876543210"
              title="10-digit Indian mobile number, optionally with +91"
              type="tel"
              required
            />
          </label>
        </>
      ) : null}

      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
        Email
        <input value={email} onChange={(event) => setEmail(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm normal-case text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" placeholder="name@example.com" type="email" required />
      </label>

      <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
        Password
        <input value={password} onChange={(event) => setPassword(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" minLength={8} placeholder="Minimum 8 characters" type="password" required />
      </label>

      <button className="inline-flex h-11 items-center justify-center gap-2 rounded border border-emerald-400 bg-emerald-400 px-4 text-sm font-semibold text-slate-950 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60" disabled={isSubmitting} type="submit">
        {isSubmitting ? "Working..." : isRegister ? "Create account" : "Login"}
        <ArrowRight size={16} />
      </button>

      {error ? <p className="text-sm text-red-300">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-300">
        <p>
          {isRegister ? "Already registered?" : "New to Option Decode?"}{" "}
          <a className="font-semibold text-emerald-300 transition hover:text-emerald-200" href={isRegister ? "/login" : "/register"}>
            {isRegister ? "Login" : "Register"}
          </a>
        </p>
        {!isRegister ? (
          <a className="font-semibold text-emerald-300 transition hover:text-emerald-200" href="/forgot-password">
            Forgot password?
          </a>
        ) : null}
      </div>
    </form>
  );
}

async function submitAuth(mode: AuthMode, payload: { email: string; password: string; displayName?: string; mobile?: string }) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const response = await fetch(`${apiUrl}/api/auth/${mode}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    credentials: "include",
    body: JSON.stringify({
      email: payload.email,
      password: payload.password,
      displayName: payload.displayName?.trim() || undefined,
      mobile: payload.mobile?.trim() || undefined
    })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Account request failed with HTTP ${response.status}`);
  }

  return response.json();
}
