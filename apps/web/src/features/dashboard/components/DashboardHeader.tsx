import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@q9labs/chalk-ui";
import { Logout01Icon, Moon02Icon, Settings03Icon, Sun01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { ChalkLogo } from "../../../components/ChalkLogo";

interface DashboardHeaderProps {
  userEmail: string;
  avatarProfile: { backgroundImage: string; initials: string };
  theme: "light" | "dark" | string;
  toggleTheme: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function DashboardHeader({ userEmail, avatarProfile, theme, toggleTheme, onOpenSettings, onLogout }: DashboardHeaderProps) {
  return (
    <header className="sticky top-0 z-50 h-16 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center justify-between px-6">
      <div className="flex items-center gap-6">
        <Link to="/" className="hover:opacity-80 transition-opacity focus-visible:ring-2 focus-visible:ring-primary rounded-sm outline-none">
          <ChalkLogo className="scale-90 origin-left" />
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <Link to="/new">
          <Button size="sm" className="font-bold text-xs shadow-sm gap-1.5 h-8 px-3 rounded-full transition-all hover:scale-105 active:scale-95 bg-foreground text-background hover:bg-foreground/90">
            <HugeiconsIcon icon={Video01Icon} size={14} aria-hidden="true" /> New Room
          </Button>
        </Link>
        <div className="w-px h-5 bg-border/50 mx-1 hidden sm:block" />
        <button onClick={toggleTheme} className="p-1.5 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors focus-visible:ring-2 focus-visible:ring-primary outline-none hidden sm:block" aria-label="Toggle theme">
          <HugeiconsIcon icon={theme === "dark" ? Sun01Icon : Moon02Icon} size={16} aria-hidden="true" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger>
            <button
              className="w-8 h-8 rounded-full flex items-center justify-center border border-border/50 cursor-pointer hover:ring-2 ring-primary/20 transition-all ml-1 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-primary bg-secondary shrink-0 shadow-sm"
              style={{ backgroundImage: avatarProfile.backgroundImage }}
            >
              <span className="text-foreground font-bold text-[10px] tracking-tight uppercase">{avatarProfile.initials}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60 mt-2 rounded-xl">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col py-2 px-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Signed in as</span>
                <span className="text-sm font-bold truncate text-foreground">{userEmail}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenSettings} className="py-2.5 font-medium gap-3 cursor-pointer rounded-lg">
              <HugeiconsIcon icon={Settings03Icon} size={16} />
              Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout} className="py-2.5 font-bold gap-3 cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10 rounded-lg">
              <HugeiconsIcon icon={Logout01Icon} size={16} />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
