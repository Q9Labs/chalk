import { describe, it, expect, vi } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { NotificationStack } from "../../components/composite/NotificationStack";

describe("NotificationStack", () => {
  const notifications = [
    { id: "1", message: "Hello", type: "info" as const },
    { id: "2", message: "World", type: "success" as const },
  ];

  it("renders all notifications", async () => {
    const { getByText } = render(<NotificationStack notifications={notifications} onDismiss={() => {}} />);
    await waitFor(() => expect(getByText("Hello")).toBeDefined());
    await waitFor(() => expect(getByText("World")).toBeDefined());
  });

  it("limits visible notifications", async () => {
    const manyNotifications = Array.from({ length: 10 }, (_, i) => ({
      id: `${i}`,
      message: `Note ${i}`,
    }));
    const { queryByText } = render(<NotificationStack notifications={manyNotifications} onDismiss={() => {}} maxVisible={3} />);
    await waitFor(() => expect(queryByText("Note 0")).toBeDefined());
    await waitFor(() => expect(queryByText("Note 1")).toBeDefined());
    await waitFor(() => expect(queryByText("Note 2")).toBeDefined());
    expect(queryByText("Note 3")).toBeNull();
  });
});
