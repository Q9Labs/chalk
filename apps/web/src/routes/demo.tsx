import { ChalkProvider, useChalk } from "@q9labs/chalk-react";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Field,
	FieldGroup,
	FieldLabel,
	Input,
} from "@q9labs/chalk-ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Copy, Mic, Monitor, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export const Route = createFileRoute("/demo")({ component: DemoPage });

function DemoPage() {
	return (
		<ChalkProvider debug>
			<div className="min-h-screen bg-background text-foreground font-sans">
				<DemoContent />
			</div>
		</ChalkProvider>
	);
}

function DemoContent() {
	const { joinRoom, } = useChalk();
	const [displayName, setDisplayName] = useState("");
	const [roomId, setRoomId] = useState("demo-room-001");
	const [isJoining, setIsJoining] = useState(false);

	useEffect(() => {
		if (!roomId) {
			setRoomId(`room-${Math.floor(Math.random() * 10000)}`);
		}
	}, []);

	const handleJoin = useCallback(async () => {
		if (!displayName.trim() || !roomId.trim()) return;

		setIsJoining(true);
		try {
			await joinRoom(roomId, {
				displayName: displayName.trim(),
				audio: true,
				video: true,
			});
		} catch (error) {
			console.error("Failed to join room:", error);
		} finally {
			setIsJoining(false);
		}
	}, [displayName, roomId, joinRoom]);


	return (
		<div className="flex min-h-screen flex-col bg-muted/30">
			<header className="flex h-16 items-center border-b bg-background px-6">
				<Link
					to="/"
					className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="h-4 w-4" />
					Back to Home
				</Link>
			</header>

			<main className="flex-1 flex items-center justify-center p-4">
				<div className="grid w-full max-w-5xl gap-12 lg:grid-cols-2 lg:items-center">
					<div className="space-y-6 max-w-md mx-auto lg:mx-0">
						<h1 className="text-4xl font-bold tracking-tight">
							Start your instant meeting
						</h1>
						<p className="text-lg text-muted-foreground">
							Experience ultra low-latency video calls. No sign-up required.
							Just enter a name and a room ID.
						</p>
						<div className="flex gap-4 text-sm text-muted-foreground">
							<div className="flex items-center gap-2">
								<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
									<Video className="h-4 w-4" />
								</div>
								HD Video
							</div>
							<div className="flex items-center gap-2">
								<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
									<Mic className="h-4 w-4" />
								</div>
								Clear Audio
							</div>
							<div className="flex items-center gap-2">
								<div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
									<Monitor className="h-4 w-4" />
								</div>
								Screen Share
							</div>
						</div>
					</div>

					<Card className="w-full max-w-md mx-auto border-muted shadow-xl">
						<CardHeader>
							<CardTitle className="text-xl">Join Meeting</CardTitle>
							<CardDescription>
								Configure your session settings below
							</CardDescription>
						</CardHeader>
						<CardContent>
							<form
								onSubmit={(e) => {
									e.preventDefault();
									handleJoin();
								}}
								className="space-y-4"
							>
								<FieldGroup>
									<Field>
										<FieldLabel htmlFor="display-name">Display Name</FieldLabel>
										<Input
											id="display-name"
											placeholder="e.g. Alice Smith"
											value={displayName}
											onChange={(e) => setDisplayName(e.target.value)}
											required
										/>
									</Field>
									<Field>
										<FieldLabel htmlFor="room-id">Room ID</FieldLabel>
										<div className="flex gap-2">
											<Input
												id="room-id"
												placeholder="room-name"
												value={roomId}
												onChange={(e) => setRoomId(e.target.value)}
												required
												className="font-mono flex-1"
											/>
											<Button
												type="button"
												variant="outline"
												size="icon"
												className="shrink-0"
												onClick={() => navigator.clipboard.writeText(roomId)}
											>
												<Copy className="h-4 w-4" />
											</Button>
										</div>
									</Field>
								</FieldGroup>

								<div className="pt-2">
									<Button
										type="submit"
										size="lg"
										className="w-full text-base"
										disabled={isJoining}
									>
										{isJoining ? "Joining Room..." : "Join Room"}
									</Button>
								</div>
							</form>
						</CardContent>
					</Card>
				</div>
			</main>
		</div>
	);
}
