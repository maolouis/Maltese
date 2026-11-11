import { useEffect, useState } from "react";
import { ClipboardCopy, Plus, Trash2 } from "lucide-react";
import {
  SKILLS,
  loadCustomSkills,
  loadEnabledSkills,
  loadMcpServers,
  saveCustomSkills,
  saveEnabledSkills,
  saveMcpServers,
  type CustomSkill,
  type McpServer,
  type SkillAction,
} from "./petSkills";
import "./PetSkillsSettings.css";

function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 技能设置：内置技能开关、自定义技能、MCP 服务器清单。 */
export function PetSkillsSettings() {
  const [enabled, setEnabled] = useState<SkillAction[]>(loadEnabledSkills);
  const [custom, setCustom] = useState<CustomSkill[]>(loadCustomSkills);
  const [servers, setServers] = useState<McpServer[]>(loadMcpServers);
  const [notice, setNotice] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");

  useEffect(() => {
    saveEnabledSkills(enabled);
  }, [enabled]);

  useEffect(() => {
    saveCustomSkills(custom);
  }, [custom]);

  useEffect(() => {
    saveMcpServers(servers);
  }, [servers]);

  const toggleSkill = (action: SkillAction) => {
    setEnabled((current) =>
      current.includes(action) ? current.filter((item) => item !== action) : [...current, action],
    );
  };

  const exportMcp = async () => {
    const payload = {
      mcpServers: Object.fromEntries(
        servers
          .filter((server) => server.enabled && server.command.trim())
          .map((server) => [
            server.name || server.command,
            {
              command: server.command.trim(),
              args: server.args
                .split(/\s+/)
                .map((arg) => arg.trim())
                .filter(Boolean),
            },
          ]),
      ),
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setNotice("MCP 配置已复制，粘贴到 DSH / 兼容客户端的 mcpServers 配置里即可。");
    } catch {
      setNotice("复制失败，可以手动复制下面的配置。");
    }
  };

  return (
    <section className="pet-skills" aria-label="技能">
      <header className="pet-skills__head">
        <strong>小狗能干什么</strong>
        <small>打开的技能会在聊天里被小狗自动调用，说「帮我记个待办」就会真的记下来。</small>
      </header>

      <div className="pet-skills__grid">
        {SKILLS.map((skill) => (
          <label key={skill.action} className="pet-skills__item">
            <input
              type="checkbox"
              checked={enabled.includes(skill.action)}
              onChange={() => toggleSkill(skill.action)}
            />
            <span>
              <b>{skill.title}</b>
              <small>{skill.description}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="pet-skills__section">
        <strong>自定义技能</strong>
        <small>写一段说明，小狗在聊天时会照着做（相当于安装一个轻量 skill）。</small>
        <div className="pet-skills__form">
          <input
            value={draftName}
            placeholder="技能名，例如：每日复盘"
            onChange={(event) => setDraftName(event.currentTarget.value)}
          />
          <textarea
            value={draftInstructions}
            rows={3}
            placeholder="说明：什么时候用、要做什么，例如「主人说复盘时，把今天未完成的待办列出来并给一句建议」。"
            onChange={(event) => setDraftInstructions(event.currentTarget.value)}
          />
          <button
            type="button"
            onClick={() => {
              const name = draftName.trim();
              const instructions = draftInstructions.trim();
              if (!name || !instructions) {
                setNotice("技能名和说明都要填。");
                return;
              }
              setCustom((current) => [...current, { id: createId(), name, instructions }]);
              setDraftName("");
              setDraftInstructions("");
              setNotice(`已添加技能：${name}`);
            }}
          >
            <Plus size={14} /> 添加技能
          </button>
        </div>
        {custom.length > 0 && (
          <ul className="pet-skills__list">
            {custom.map((skill) => (
              <li key={skill.id}>
                <div>
                  <b>{skill.name}</b>
                  <small>{skill.instructions}</small>
                </div>
                <button
                  type="button"
                  title="删除"
                  aria-label={`删除 ${skill.name}`}
                  onClick={() => setCustom((current) => current.filter((item) => item.id !== skill.id))}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pet-skills__section">
        <strong>MCP 服务器</strong>
        <small>
          这里只做登记和配置导出。MCP 的工具由 DSH 之类的宿主执行，Maltese 不直接连接第三方服务器。
        </small>
        <div className="pet-skills__form">
          <input
            value={mcpName}
            placeholder="名称，例如 filesystem"
            onChange={(event) => setMcpName(event.currentTarget.value)}
          />
          <input
            value={mcpCommand}
            placeholder="启动命令，例如 npx"
            onChange={(event) => setMcpCommand(event.currentTarget.value)}
          />
          <input
            value={mcpArgs}
            placeholder="参数，例如 -y @modelcontextprotocol/server-filesystem D:\\notes"
            onChange={(event) => setMcpArgs(event.currentTarget.value)}
          />
          <div className="pet-skills__row">
            <button
              type="button"
              onClick={() => {
                if (!mcpCommand.trim()) {
                  setNotice("启动命令不能为空。");
                  return;
                }
                setServers((current) => [
                  ...current,
                  {
                    id: createId(),
                    name: mcpName.trim() || mcpCommand.trim(),
                    command: mcpCommand.trim(),
                    args: mcpArgs.trim(),
                    enabled: true,
                  },
                ]);
                setMcpName("");
                setMcpCommand("");
                setMcpArgs("");
              }}
            >
              <Plus size={14} /> 添加服务器
            </button>
            <button type="button" onClick={() => void exportMcp()}>
              <ClipboardCopy size={14} /> 复制 MCP 配置
            </button>
          </div>
        </div>
        {servers.length > 0 && (
          <ul className="pet-skills__list">
            {servers.map((server) => (
              <li key={server.id}>
                <label className="pet-skills__server">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={() =>
                      setServers((current) =>
                        current.map((item) =>
                          item.id === server.id ? { ...item, enabled: !item.enabled } : item,
                        ),
                      )
                    }
                  />
                  <div>
                    <b>{server.name}</b>
                    <small>
                      {server.command} {server.args}
                    </small>
                  </div>
                </label>
                <button
                  type="button"
                  title="删除"
                  aria-label={`删除 ${server.name}`}
                  onClick={() => setServers((current) => current.filter((item) => item.id !== server.id))}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {notice && <p className="pet-skills__notice">{notice}</p>}
    </section>
  );
}