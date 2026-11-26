import { useEffect } from "react";
import { PEOPLE, chatMessages, liveSnapshot } from "./fixtures";
import { Live } from "./live";

const others = [PEOPLE[0]!, PEOPLE[1]!];

export function ChatFileDropFixture() {
  useEffect(() => {
    let timer = 0;
    let attempts = 0;
    const openAndDrag = () => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Chat"]');
      const frame = document.querySelector<HTMLElement>("[data-part=call-frame]");
      if ((!button || !frame) && attempts++ < 20) {
        timer = window.setTimeout(openAndDrag, 50);
        return;
      }
      button?.click();
      timer = window.setTimeout(() => {
        const target = document.querySelector<HTMLElement>("[data-part=call-frame]");
        if (!target) return;
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(["pdf"], "Algebra worksheet.pdf", { type: "application/pdf" }));
        for (const type of ["dragenter", "dragover"]) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
      }, 100);
    };
    openAndDrag();
    return () => window.clearTimeout(timer);
  }, []);
  return <Live snapshot={liveSnapshot({ others: others, chat: chatMessages() })} />;
}
