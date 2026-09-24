"use client";

import { useEffect, useState } from "react";
import { AudioLines, CircleUserRound, Crown, LayoutDashboard, LogIn } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Account = { user?: { role?: string }; entitlement?: { plan?: { name?: string }; remainingSeconds?: number | null } };

export function SiteNav({ compact = false }: { compact?: boolean }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fetch("/api/account", { credentials: "same-origin" })
      .then(async (response) => response.ok ? (await response.json()).account : null)
      .then(setAccount)
      .finally(() => setLoaded(true));
  }, []);
  const plan = account?.entitlement?.plan?.name;
  const isOwner = account?.user?.role === "owner";

  return (
    <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <a className="flex min-w-0 items-center gap-3" href="/">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_30px_rgba(54,211,153,.22)]"><AudioLines className="size-5" /></span>
        <span className={compact ? "hidden sm:block" : "block"}>
          <span className="block text-[15px] font-semibold leading-none tracking-tight">听见 · 总结</span>
          <span className="mt-1 block text-xs text-muted-foreground">B站视频内容提炼</span>
        </span>
      </a>
      <nav className="flex items-center gap-1.5" aria-label="主导航">
        <Button variant="ghost" size="sm" asChild><a href="/pricing">套餐</a></Button>
        {account ? (
          <>
            {plan && <Badge variant="outline" className="hidden border-primary/30 text-primary sm:inline-flex">{isOwner && <Crown className="mr-1 size-3" />}{plan}</Badge>}
            {isOwner && <Button variant="ghost" size="sm" asChild><a href="/admin"><LayoutDashboard className="size-4" /><span className="hidden sm:inline">后台</span></a></Button>}
            <Button variant="outline" size="sm" asChild><a href="/account"><CircleUserRound className="size-4" /><span className="hidden sm:inline">我的账户</span></a></Button>
          </>
        ) : loaded ? (
          <Button size="sm" asChild><a href="/signin-with-chatgpt?return_to=%2F" target="_top"><LogIn className="size-4" />登录 / 注册</a></Button>
        ) : <span className="h-9 w-24 animate-pulse rounded-lg bg-secondary" />}
      </nav>
    </header>
  );
}
