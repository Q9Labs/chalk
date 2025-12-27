import { X } from "lucide-react";
import { SettingsIcon } from "./icons";

export interface SettingsPanelProps {
	isOpen: boolean;
	onClose: () => void;
	onToggle: () => void;
	isVideoEnabled: boolean;
	isAudioEnabled: boolean;
	isScreenSharing: boolean;
	cameras: Array<{ deviceId: string; label: string }>;
	microphones: Array<{ deviceId: string; label: string }>;
	selectedCamera: string | null;
	selectedMicrophone: string | null;
	onSelectCamera: (deviceId: string) => void;
	onSelectMicrophone: (deviceId: string) => void;
}

export function SettingsPanel({
	isOpen,
	onClose,
	onToggle,
	isVideoEnabled,
	isAudioEnabled,
	isScreenSharing,
	cameras,
	microphones,
	selectedCamera,
	selectedMicrophone,
	onSelectCamera,
	onSelectMicrophone,
}: SettingsPanelProps) {
	return (
		<>
			{/* Settings button in header */}
			<button
				onClick={onToggle}
				className={`
          p-2.5 rounded-xl transition-all duration-200
          ${
						isOpen
							? "bg-accent text-accent-foreground"
							: "text-muted-foreground hover:text-foreground hover:bg-accent/60"
					}
        `}
				aria-label="Settings"
			>
				<SettingsIcon />
			</button>

			{/* Settings Panel */}
			<aside
				className={`
        absolute top-0 right-0 h-full w-80
        bg-card/95 backdrop-blur-xl
        border-l border-border
        transform transition-transform duration-300 ease-out
        ${isOpen ? "translate-x-0" : "translate-x-full"}
        z-30 overflow-y-auto
      `}
			>
				<div className="p-5 space-y-6">
					{/* Header */}
					<div className="flex items-center justify-between">
						<h2 className="text-lg font-semibold text-foreground">Settings</h2>
						<button
							onClick={onClose}
							className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
						>
							<X className="w-5 h-5" />
						</button>
					</div>

					{/* Device Selection */}
					<div className="space-y-5">
						<div className="space-y-2">
							<label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
								Camera
							</label>
							<select
								value={selectedCamera ?? ""}
								onChange={(e) => onSelectCamera(e.target.value)}
								className="
                  w-full px-3 py-2.5 rounded-xl
                  bg-muted/60 border border-border
                  text-sm text-foreground
                  focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30
                  transition-all
                "
							>
								{cameras.map((camera) => (
									<option key={camera.deviceId} value={camera.deviceId}>
										{camera.label || `Camera ${camera.deviceId.slice(0, 5)}...`}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<label className="block text-xs font-medium text-muted-foreground uppercase tracking-wider">
								Microphone
							</label>
							<select
								value={selectedMicrophone ?? ""}
								onChange={(e) => onSelectMicrophone(e.target.value)}
								className="
                  w-full px-3 py-2.5 rounded-xl
                  bg-muted/60 border border-border
                  text-sm text-foreground
                  focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/30
                  transition-all
                "
							>
								{microphones.map((mic) => (
									<option key={mic.deviceId} value={mic.deviceId}>
										{mic.label || `Mic ${mic.deviceId.slice(0, 5)}...`}
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Status Section */}
					<div className="space-y-3 pt-4 border-t border-border">
						<h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
							Your Status
						</h3>
						<div className="space-y-2">
							<div className="flex items-center justify-between p-3 rounded-xl bg-muted/40">
								<span className="text-sm text-muted-foreground">Camera</span>
								<span
									className={`text-sm font-medium ${isVideoEnabled ? "text-emerald-400" : "text-destructive"}`}
								>
									{isVideoEnabled ? "On" : "Off"}
								</span>
							</div>
							<div className="flex items-center justify-between p-3 rounded-xl bg-muted/40">
								<span className="text-sm text-muted-foreground">Microphone</span>
								<span
									className={`text-sm font-medium ${isAudioEnabled ? "text-emerald-400" : "text-destructive"}`}
								>
									{isAudioEnabled ? "On" : "Off"}
								</span>
							</div>
							{isScreenSharing && (
								<div className="flex items-center justify-between p-3 rounded-xl bg-primary/10 border border-primary/20">
									<span className="text-sm text-primary/80">Screen Share</span>
									<span className="text-sm font-medium text-primary">
										Active
									</span>
								</div>
							)}
						</div>
					</div>
				</div>
			</aside>
		</>
	);
}
