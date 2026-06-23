"use client";

import { ArrowRight, LockKeyhole } from "lucide-react";
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
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
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
        displayName
      });
      router.replace("/app?view=dashboard");
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Unable to complete account request");
    } finally {
      setIsSubmitting(false);
    }
  };

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
        <label className="grid gap-1 text-xs font-semibold uppercase text-slate-300">
          Name
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="h-11 rounded border border-white/15 bg-white/10 px-3 text-sm normal-case text-white outline-none transition placeholder:text-slate-500 focus:border-emerald-300" placeholder="Your name" />
        </label>
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

async function submitAuth(mode: AuthMode, payload: { email: string; password: string; displayName?: string }) {
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
      displayName: payload.displayName?.trim() || undefined
    })
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `Account request failed with HTTP ${response.status}`);
  }

  return response.json();
}
