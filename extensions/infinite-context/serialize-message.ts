import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Authoritative text projection shared by lookup and search. Binary image bytes stay in the session source. */
export function serializeMessage(message: AgentMessage): string {
  if (message.role === "branchSummary" || message.role === "compactionSummary")
    return message.summary;
  if (message.role === "bashExecution") {
    let text = `Ran \`${message.command ?? ""}\`\n`;
    text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
    if (message.cancelled) text += "\n\n(command cancelled)";
    else if (message.exitCode != null && message.exitCode !== 0)
      text += `\n\nCommand exited with code ${message.exitCode}`;
    if (message.truncated && message.fullOutputPath)
      text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
    return text;
  }
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "thinking") parts.push(`(thinking) ${block.thinking}`);
    else if (block.type === "toolCall")
      parts.push(`(call ${block.name} ${JSON.stringify(block.arguments)})`);
    else if (block.type === "image")
      parts.push(`(image ${block.mimeType}; binary source preserved in session)`);
  }
  return parts.join("\n");
}
