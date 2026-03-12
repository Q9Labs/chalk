import { useEffect, useState } from "react";
import { User, Palette } from "lucide-react";
import { toast } from "sonner";
import { Button, Input, Separator, Dialog, DialogContent, DialogClose } from "@q9labs/chalk-ui";
import { useTheme } from "../context/theme";
import { AVATAR_GRADIENT_PRESETS, DEFAULT_AVATAR_GRADIENT_PREFERENCE, getAvatarGradientCss, notifyUserSettingsUpdated } from "../lib/avatarGradient";
import { useProfileAvatar } from "../lib/useProfileAvatar";
import { cn } from "../lib/utils";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"profile" | "appearance">("profile");
  const { theme, setTheme } = useTheme();

  const [displayName, setDisplayName] = useState("");
  const [joinMuted, setJoinMuted] = useState(false);
  const [joinNoVideo, setJoinNoVideo] = useState(false);
  const avatarProfile = useProfileAvatar({
    displayNameOverride: displayName || undefined,
  });

  useEffect(() => {
    if (isOpen) {
      setDisplayName(localStorage.getItem("chalk_default_name") || "");
      setJoinMuted(localStorage.getItem("chalk_join_muted") === "true");
      setJoinNoVideo(localStorage.getItem("chalk_join_no_video") === "true");
    }
  }, [isOpen]);

  const handleSave = () => {
    localStorage.setItem("chalk_default_name", displayName);
    localStorage.setItem("chalk_join_muted", String(joinMuted));
    localStorage.setItem("chalk_join_no_video", String(joinNoVideo));
    notifyUserSettingsUpdated();
    toast.success("Settings saved successfully");
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[840px] p-0 overflow-hidden border-none shadow-2xl rounded-3xl">
        <div className="flex flex-col md:flex-row min-h-[540px] bg-card">
          <DialogClose className="top-6 right-6" />

          {/* Sidebar Navigation */}
          <div className="w-full md:w-[240px] bg-muted/30 border-r border-border p-8 flex flex-col">
            <div className="flex items-center justify-between mb-10">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] text-muted-foreground/60">Preferences</h2>
            </div>

            <nav className="space-y-1.5 flex-1">
              <button
                onClick={() => setActiveTab("profile")}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-primary group",
                  activeTab === "profile" ? "bg-primary text-primary-foreground shadow-xl shadow-primary/20" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <User size={18} className={cn("transition-transform duration-300", activeTab === "profile" && "scale-110")} />
                Profile
              </button>

              <button
                onClick={() => setActiveTab("appearance")}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-primary group",
                  activeTab === "appearance" ? "bg-primary text-primary-foreground shadow-xl shadow-primary/20" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Palette size={18} className={cn("transition-transform duration-300", activeTab === "appearance" && "scale-110")} />
                Appearance
              </button>
            </nav>

            <div className="mt-auto pt-8 border-t border-border/10">
              <p className="text-[10px] font-black text-muted-foreground/30 uppercase tracking-[0.1em]">Chalk Preview v1.2</p>
            </div>
          </div>

          {/* Content Area */}
          <div className="flex-1 p-10 sm:p-12 bg-card relative overflow-y-auto max-h-[85vh] md:max-h-none">
            {activeTab === "profile" && (
              <div className="space-y-10 animate-in fade-in slide-in-from-right-8 duration-700 ease-out">
                <div>
                  <h3 className="text-3xl font-black tracking-tight text-foreground">Profile Defaults</h3>
                  <p className="text-sm text-muted-foreground mt-3 font-medium leading-relaxed max-w-md">Customize your identity and meeting entry automated settings.</p>
                </div>

                <div className="space-y-8">
                  <div className="space-y-3">
                    <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">Display Name</label>
                    <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="E.g. Hasan" className="h-14 bg-muted/20 border-border/40 focus:border-primary/50 focus:ring-primary/10 transition-all font-bold text-base px-5 rounded-2xl" />
                    <p className="text-[11px] font-medium text-muted-foreground/70 ml-1">This label will appear above your video feed in meetings.</p>
                  </div>

                  <Separator className="opacity-30" />

                  <div className="space-y-5">
                    <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">Entry Preferences</label>

                    <div className="space-y-3">
                      <button onClick={() => setJoinMuted(!joinMuted)} className="flex items-center justify-between w-full p-5 rounded-3xl bg-muted/10 border border-border/30 hover:bg-muted/20 hover:border-primary/20 transition-all group cursor-pointer">
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-sm font-bold text-foreground">Join Muted</span>
                          <span className="text-[11px] font-semibold text-muted-foreground/80 text-left">Auto-disable microphone on entry</span>
                        </div>
                        <div className={cn("w-11 h-6 rounded-full p-1 transition-all duration-300 shadow-inner", joinMuted ? "bg-primary" : "bg-muted-foreground/20")}>
                          <div className={cn("w-4 h-4 bg-white rounded-full transition-all duration-300 shadow-sm", joinMuted ? "translate-x-5 scale-110" : "translate-x-0")} />
                        </div>
                      </button>

                      <button onClick={() => setJoinNoVideo(!joinNoVideo)} className="flex items-center justify-between w-full p-5 rounded-3xl bg-muted/10 border border-border/30 hover:bg-muted/20 hover:border-primary/20 transition-all group cursor-pointer">
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-sm font-bold text-foreground">Video Off</span>
                          <span className="text-[11px] font-semibold text-muted-foreground/80 text-left">Auto-disable camera on entry</span>
                        </div>
                        <div className={cn("w-11 h-6 rounded-full p-1 transition-all duration-300 shadow-inner", joinNoVideo ? "bg-primary" : "bg-muted-foreground/20")}>
                          <div className={cn("w-4 h-4 bg-white rounded-full transition-all duration-300 shadow-sm", joinNoVideo ? "translate-x-5 scale-110" : "translate-x-0")} />
                        </div>
                      </button>
                    </div>
                  </div>

                  <div className="pt-6">
                    <Button onClick={handleSave} className="h-14 px-10 font-black text-sm rounded-2xl shadow-2xl shadow-primary/25 active:scale-[0.98] transition-all hover:translate-y-[-2px]">
                      Update Profile
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "appearance" && (
              <div className="space-y-10 animate-in fade-in slide-in-from-right-8 duration-700 ease-out">
                <div>
                  <h3 className="text-3xl font-black tracking-tight text-foreground">Appearance</h3>
                  <p className="text-sm text-muted-foreground mt-3 font-medium leading-relaxed max-w-md">Choose an interface style that fits your workflow.</p>
                </div>

                <div className="space-y-8">
                  <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">Theme Palette</label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                    {/* Light Theme */}
                    <button
                      onClick={() => setTheme("light")}
                      className={cn(
                        "relative p-5 rounded-[24px] border-2 text-left transition-all h-[140px] flex flex-col justify-between items-start group overflow-hidden active:scale-95",
                        theme === "light" ? "border-primary bg-primary/5 shadow-2xl shadow-primary/10 ring-8 ring-primary/5" : "border-border/50 hover:border-primary/30 bg-background",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full border-2 border-border/50 flex items-center justify-center bg-white">{theme === "light" && <div className="w-3 h-3 rounded-full bg-primary" />}</div>
                        <span className="font-black text-sm text-zinc-900 tracking-tight">Light</span>
                      </div>
                      <div className="w-full h-14 rounded-xl bg-zinc-100 border border-zinc-200 flex flex-col p-3 gap-2 shadow-inner">
                        <div className="w-1/2 h-2.5 rounded-full bg-white shadow-sm" />
                        <div className="w-3/4 h-2.5 rounded-full bg-zinc-200" />
                      </div>
                    </button>

                    {/* Nordish Theme */}
                    <button
                      onClick={() => setTheme("nord")}
                      className={cn(
                        "relative p-5 rounded-[24px] border-2 text-left transition-all h-[140px] flex flex-col justify-between items-start group overflow-hidden active:scale-95",
                        theme === "nord" ? "border-[#88C0D0] bg-[#88C0D0]/10 shadow-2xl shadow-[#88C0D0]/10 ring-8 ring-[#88C0D0]/5" : "border-border/50 hover:border-[#88C0D0]/30 bg-[#2E3440]",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full border-2 border-[#4C566A] flex items-center justify-center bg-[#3B4252]">{theme === "nord" && <div className="w-3 h-3 rounded-full bg-[#88C0D0]" />}</div>
                        <span className="font-black text-sm text-[#ECEFF4] tracking-tight">Nordish</span>
                      </div>
                      <div className="w-full h-14 rounded-xl bg-[#3B4252] border border-[#4C566A] flex flex-col p-3 gap-2 shadow-inner">
                        <div className="w-1/2 h-2.5 rounded-full bg-[#4C566A] shadow-sm" />
                        <div className="w-3/4 h-2.5 rounded-full bg-[#434C5E]" />
                      </div>
                    </button>

                    {/* Dark Theme */}
                    <button
                      onClick={() => setTheme("dark")}
                      className={cn(
                        "relative p-5 rounded-[24px] border-2 text-left transition-all h-[140px] flex flex-col justify-between items-start group overflow-hidden active:scale-95",
                        theme === "dark" ? "border-primary bg-primary/10 shadow-2xl shadow-primary/20 ring-8 ring-primary/10" : "border-border/50 hover:border-primary/30 bg-[#09090b]",
                      )}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full border-2 border-zinc-800 flex items-center justify-center bg-zinc-900">{theme === "dark" && <div className="w-3 h-3 rounded-full bg-primary" />}</div>
                        <span className="font-black text-sm text-zinc-50 tracking-tight">Dark</span>
                      </div>
                      <div className="w-full h-14 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col p-3 gap-2 shadow-inner">
                        <div className="w-1/2 h-2.5 rounded-full bg-zinc-800 shadow-sm" />
                        <div className="w-3/4 h-2.5 rounded-full bg-zinc-950" />
                      </div>
                    </button>
                  </div>

                  <Separator className="opacity-30" />

                  <div className="space-y-5">
                    <div>
                      <label className="text-[11px] font-black uppercase tracking-widest text-muted-foreground">Profile Gradient</label>
                      <p className="mt-2 text-sm text-muted-foreground max-w-lg">Your avatar derives from your name by default. Or lock in one of these preset blends.</p>
                    </div>

                    <div className="rounded-[28px] border border-border/40 bg-muted/10 p-6">
                      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                        <div className="flex items-center gap-4">
                          <div className="flex h-20 w-20 items-center justify-center rounded-full border border-white/20 text-lg font-black uppercase tracking-tight text-white shadow-xl shadow-black/10" style={{ backgroundImage: avatarProfile.backgroundImage }}>
                            {avatarProfile.initials}
                          </div>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-foreground">{avatarProfile.title}</p>
                            <p className="text-xs font-semibold text-muted-foreground">{avatarProfile.description}</p>
                          </div>
                        </div>
                      </div>

                      <div className="mt-6 flex flex-wrap gap-3">
                        <button
                          type="button"
                          aria-label="Use derived profile gradient"
                          onClick={() => avatarProfile.setPreference(DEFAULT_AVATAR_GRADIENT_PREFERENCE)}
                          className={cn("group flex flex-col items-center gap-2 rounded-2xl border px-3 py-3 transition-all", avatarProfile.preference.mode === "derived" ? "border-primary bg-primary/10 shadow-lg shadow-primary/10" : "border-border/40 bg-background hover:border-primary/30")}
                        >
                          <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/20 text-[11px] font-black uppercase tracking-tight text-white shadow-md" style={{ backgroundImage: getAvatarGradientCss(avatarProfile.gradient) }}>
                            {avatarProfile.initials}
                          </span>
                          <span className="text-[11px] font-black uppercase tracking-widest text-foreground">Auto</span>
                        </button>

                        {AVATAR_GRADIENT_PRESETS.map((preset) => {
                          const isSelected = avatarProfile.preference.mode === "preset" && avatarProfile.preference.presetId === preset.id;

                          return (
                            <button
                              key={preset.id}
                              type="button"
                              aria-label={`Use ${preset.label} profile gradient`}
                              onClick={() =>
                                avatarProfile.setPreference({
                                  mode: "preset",
                                  presetId: preset.id,
                                })
                              }
                              className={cn("group flex flex-col items-center gap-2 rounded-2xl border px-3 py-3 transition-all", isSelected ? "border-primary bg-primary/10 shadow-lg shadow-primary/10" : "border-border/40 bg-background hover:border-primary/30")}
                            >
                              <span className="h-12 w-12 rounded-full border border-white/20 shadow-md" style={{ backgroundImage: getAvatarGradientCss({ start: preset.start, end: preset.end }) }} />
                              <span className="text-[11px] font-black uppercase tracking-widest text-foreground">{preset.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
