import { Link, useLocation } from "@tanstack/react-router";
import { BookOpen, Code2, Key, LayoutGrid, Puzzle, Zap } from "lucide-react";

interface NavItem {
	label: string;
	href: string;
	icon: React.ReactNode;
	children?: NavItem[];
}

const navigation: NavItem[] = [
	{
		label: "Getting Started",
		href: "/docs/getting-started",
		icon: <Zap size={18} />,
	},
	{
		label: "Authentication",
		href: "/docs/authentication",
		icon: <Key size={18} />,
	},
	{
		label: "SDK React",
		href: "/docs/sdk-react",
		icon: <Code2 size={18} />,
		children: [
			{
				label: "Hooks",
				href: "/docs/hooks",
				icon: <Puzzle size={18} />,
			},
			{
				label: "Components",
				href: "/docs/components",
				icon: <LayoutGrid size={18} />,
			},
		],
	},
	{
		label: "API Reference",
		href: "/docs/api-reference",
		icon: <BookOpen size={18} />,
	},
];

export function DocsSidebar() {
	const location = useLocation();
	const currentPath = location.pathname;

	return (
		<aside className="w-64 shrink-0 border-r border-border bg-sidebar h-[calc(100vh-64px)] sticky top-16 overflow-y-auto">
			<nav className="p-4 space-y-1">
				<div className="mb-6">
					<Link
						to="/docs"
						className="flex items-center gap-2 text-lg font-semibold text-foreground hover:text-primary transition-colors"
					>
						<BookOpen size={24} className="text-primary" />
						Chalk Docs
					</Link>
				</div>

				{navigation.map((item) => (
					<NavItemComponent
						key={item.href}
						item={item}
						currentPath={currentPath}
					/>
				))}
			</nav>
		</aside>
	);
}

function NavItemComponent({
	item,
	currentPath,
	depth = 0,
}: {
	item: NavItem;
	currentPath: string;
	depth?: number;
}) {
	const isActive = currentPath === item.href;
	const hasChildren = item.children && item.children.length > 0;
	const isChildActive = item.children?.some(
		(child) => currentPath === child.href,
	);

	return (
		<div>
			<Link
				to={item.href}
				className={`
					flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors
					${depth > 0 ? "ml-6" : ""}
					${
						isActive
							? "bg-primary text-primary-foreground"
							: isChildActive
								? "text-primary"
								: "text-muted-foreground hover:text-foreground hover:bg-accent"
					}
				`}
			>
				{item.icon}
				{item.label}
			</Link>

			{hasChildren && (
				<div className="mt-1 space-y-1">
					{item.children?.map((child) => (
						<NavItemComponent
							key={child.href}
							item={child}
							currentPath={currentPath}
							depth={depth + 1}
						/>
					))}
				</div>
			)}
		</div>
	);
}
