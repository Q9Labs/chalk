import { MDXProvider } from "@mdx-js/react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { Callout } from "./Callout";
import { CodeBlock } from "./CodeBlock";
import { DocsSidebar } from "./DocsSidebar";

const mdxComponents = {
	h1: (props: ComponentProps<"h1">) => (
		<h1
			className="text-3xl font-bold mt-8 mb-4 text-foreground first:mt-0"
			{...props}
		/>
	),
	h2: (props: ComponentProps<"h2">) => (
		<h2
			className="text-2xl font-semibold mt-8 mb-3 pb-2 border-b border-border text-foreground"
			{...props}
		/>
	),
	h3: (props: ComponentProps<"h3">) => (
		<h3 className="text-xl font-medium mt-6 mb-2 text-foreground" {...props} />
	),
	p: (props: ComponentProps<"p">) => (
		<p className="my-4 leading-relaxed text-foreground/90" {...props} />
	),
	ul: (props: ComponentProps<"ul">) => (
		<ul className="list-disc pl-6 my-4 space-y-2" {...props} />
	),
	ol: (props: ComponentProps<"ol">) => (
		<ol className="list-decimal pl-6 my-4 space-y-2" {...props} />
	),
	li: (props: ComponentProps<"li">) => (
		<li className="text-foreground/90" {...props} />
	),
	code: (props: ComponentProps<"code">) => {
		const isInline = !props.className?.includes("language-");
		if (isInline) {
			return (
				<code
					className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-primary"
					{...props}
				/>
			);
		}
		return <code {...props} />;
	},
	pre: ({ children, ...props }: ComponentProps<"pre">) => {
		// MDX wraps code in <pre><code>...</code></pre>
		// Extract the code element and its content
		const codeElement = children as React.ReactElement<{
			className?: string;
			children?: string | string[];
		}>;

		if (!codeElement?.props) {
			return <pre {...props}>{children}</pre>;
		}

		const className = codeElement.props.className || "";
		const language = className.replace("language-", "") || "text";

		// Handle both string and array children
		const codeContent = codeElement.props.children;
		const code = Array.isArray(codeContent)
			? codeContent.join("")
			: (codeContent || "");

		return <CodeBlock language={language}>{code}</CodeBlock>;
	},
	table: (props: ComponentProps<"table">) => (
		<div className="my-6 overflow-x-auto rounded-lg border border-border">
			<table className="w-full text-sm" {...props} />
		</div>
	),
	thead: (props: ComponentProps<"thead">) => (
		<thead className="bg-muted" {...props} />
	),
	th: (props: ComponentProps<"th">) => (
		<th
			className="px-4 py-3 text-left font-medium text-foreground"
			{...props}
		/>
	),
	td: (props: ComponentProps<"td">) => (
		<td className="px-4 py-3 border-t border-border" {...props} />
	),
	a: (props: ComponentProps<"a">) => (
		<a
			className="text-primary hover:underline font-medium"
			target={props.href?.startsWith("http") ? "_blank" : undefined}
			rel={props.href?.startsWith("http") ? "noopener noreferrer" : undefined}
			{...props}
		/>
	),
	blockquote: (props: ComponentProps<"blockquote">) => (
		<blockquote
			className="border-l-4 border-primary pl-4 my-4 italic text-muted-foreground"
			{...props}
		/>
	),
	hr: () => <hr className="my-8 border-border" />,
	Callout,
	CodeBlock,
};

interface DocsLayoutProps {
	children: ReactNode;
}

export function DocsLayout({ children }: DocsLayoutProps) {
	return (
		<div className="min-h-screen bg-background">
			<header className="h-16 border-b border-border bg-background/95 backdrop-blur sticky top-0 z-40">
				<div className="h-full flex items-center px-6 gap-4">
					<Link
						to="/"
						className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
					>
						<ArrowLeft size={18} />
						<span className="text-sm">Back to App</span>
					</Link>
					<div className="h-6 w-px bg-border" />
					<span className="text-lg font-semibold text-foreground">
						Chalk Documentation
					</span>
				</div>
			</header>

			<div className="flex">
				<DocsSidebar />

				<main className="flex-1 min-w-0">
					<div className="max-w-4xl mx-auto px-8 py-12">
						<MDXProvider components={mdxComponents}>{children}</MDXProvider>
					</div>
				</main>
			</div>
		</div>
	);
}
