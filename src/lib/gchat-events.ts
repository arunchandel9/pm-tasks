/**
 * Google Chat sends two event shapes depending on how the app was configured:
 *  - classic:  { type: "MESSAGE" | "ADDED_TO_SPACE" | "CARD_CLICKED", message, space, user, common, action, isDialogEvent, dialogEventType }
 *  - add-on:   { chat: { messagePayload | addedToSpacePayload | appCommandPayload | buttonClickedPayload, user, eventTime }, commonEventObject }
 * Everything downstream works on this one normalised shape, and replies are built per format.
 */

export interface ChatAttachment { name?: string; contentName?: string; contentType?: string; attachmentDataRef?: { resourceName?: string } }
export interface ChatMessage { name: string; thread?: { name?: string }; text?: string; argumentText?: string; createTime?: string; sender?: { email?: string; displayName?: string }; attachment?: ChatAttachment[]; slashCommand?: { commandId?: string | number } }

export interface NormalisedEvent {
  format: "classic" | "addon";
  kind: "added" | "message" | "command" | "click" | "dialog_submit" | "other";
  space: string;
  user: { email?: string; displayName?: string };
  message: ChatMessage | null;
  commandId: string | null;
  invokedFunction: string;
  parameters: Record<string, string>;
  formInputs: Record<string, { stringInputs?: { value?: string[] } }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normaliseChatEvent(ev: any, fnHint?: string | null): NormalisedEvent {
  const formInputs = ev.commonEventObject?.formInputs ?? ev.common?.formInputs ?? {};
  // Add-on style apps call the handler URL (…/api/gchat?fn=name); classic apps pass the name. Normalise to the name.
  const rawFn: string = ev.commonEventObject?.invokedFunction ?? ev.common?.invokedFunction ?? ev.action?.actionMethodName ?? "";
  const m = rawFn.match(/[?&]fn=([^&]+)/);
  const invokedFunction: string = fnHint || (m ? decodeURIComponent(m[1]) : rawFn);
  const parameters: Record<string, string> = { ...(ev.commonEventObject?.parameters ?? {}), ...(ev.common?.parameters ?? {}) };
  for (const p of ev.action?.parameters ?? []) parameters[p.key] = p.value;

  if (ev.chat) {
    const c = ev.chat;
    const user = { email: c.user?.email, displayName: c.user?.displayName };
    if (c.addedToSpacePayload) return { format: "addon", kind: "added", space: c.addedToSpacePayload.space?.name ?? "", user, message: null, commandId: null, invokedFunction, parameters, formInputs };
    if (c.appCommandPayload) {
      const meta = c.appCommandPayload.appCommandMetadata ?? {};
      return { format: "addon", kind: "command", space: c.appCommandPayload.space?.name ?? c.appCommandPayload.message?.space?.name ?? "", user, message: c.appCommandPayload.message ?? null, commandId: meta.appCommandId != null ? String(meta.appCommandId) : null, invokedFunction, parameters, formInputs };
    }
    if (c.buttonClickedPayload) {
      const kind = invokedFunction === "submit_task" ? "dialog_submit" : "click";
      return { format: "addon", kind, space: c.buttonClickedPayload.space?.name ?? c.buttonClickedPayload.message?.space?.name ?? "", user, message: c.buttonClickedPayload.message ?? null, commandId: null, invokedFunction, parameters, formInputs };
    }
    if (c.messagePayload) {
      const msg = c.messagePayload.message ?? null;
      const cmd = msg?.slashCommand?.commandId;
      return { format: "addon", kind: cmd != null ? "command" : "message", space: c.messagePayload.space?.name ?? msg?.space?.name ?? "", user, message: msg, commandId: cmd != null ? String(cmd) : null, invokedFunction, parameters, formInputs };
    }
    return { format: "addon", kind: "other", space: "", user, message: null, commandId: null, invokedFunction, parameters, formInputs };
  }

  const user = { email: ev.user?.email, displayName: ev.user?.displayName };
  const space: string = ev.space?.name ?? ev.message?.space?.name ?? "";
  if (ev.type === "ADDED_TO_SPACE") return { format: "classic", kind: "added", space, user, message: null, commandId: null, invokedFunction, parameters, formInputs };
  if (ev.isDialogEvent && ev.dialogEventType === "SUBMIT") return { format: "classic", kind: "dialog_submit", space, user, message: ev.message ?? null, commandId: null, invokedFunction, parameters, formInputs };
  if (ev.type === "CARD_CLICKED") return { format: "classic", kind: "click", space, user, message: ev.message ?? null, commandId: null, invokedFunction, parameters, formInputs };
  if (ev.type === "MESSAGE") {
    const cmd = ev.message?.slashCommand?.commandId;
    return { format: "classic", kind: cmd != null ? "command" : "message", space, user, message: ev.message ?? null, commandId: cmd != null ? String(cmd) : null, invokedFunction, parameters, formInputs };
  }
  return { format: "classic", kind: "other", space, user, message: null, commandId: null, invokedFunction, parameters, formInputs };
}

// ---- replies, per format ----

export function replyText(format: "classic" | "addon", text: string) {
  return format === "addon" ? { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text } } } } } : { text };
}

export function replyUpdateMessage(format: "classic" | "addon", text: string) {
  return format === "addon"
    ? { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { text, cardsV2: [] } } } } }
    : { actionResponse: { type: "UPDATE_MESSAGE" }, text, cardsV2: [] };
}

/** Open a dialog. Add-on style apps open dialogs by pushing a card (RenderActions); classic apps use a DIALOG action response. */
export function replyDialog(format: "classic" | "addon", body: unknown) {
  return format === "addon"
    ? { action: { navigations: [{ pushCard: body }] } }
    : { actionResponse: { type: "DIALOG", dialogAction: { dialog: { body } } } };
}

/** Close the dialog after a submit and show a short confirmation. */
export function replyDialogOk(format: "classic" | "addon", message: string) {
  return format === "addon"
    ? { action: { navigations: [{ endNavigation: { action: "CLOSE_DIALOG" } }] } } // confirmation goes to PM Review; the message argument is used by the classic shape only
    : { actionResponse: { type: "DIALOG", dialogAction: { actionStatus: { statusCode: "OK", userFacingMessage: message } } } };
}

/** Keep the dialog open and show a validation message. */
export function replyDialogError(format: "classic" | "addon", message: string) {
  return format === "addon"
    ? { action: { notification: { text: message } } }
    : { actionResponse: { type: "DIALOG", dialogAction: { actionStatus: { statusCode: "INVALID_ARGUMENT", userFacingMessage: message } } } };
}
