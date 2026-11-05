"""Harbor 0.25.0 installed-agent connector for the Sail compaction comparison.

Use -a harbor_agent:PiDurable with this directory on PYTHONPATH.
Harbor installs this checkout's commit in each task environment.
"""

import json
from pathlib import Path
import shlex
import subprocess
from typing import Literal

from harbor.agents.agent_auth_resolution import ResolvedModelConnection
from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext, ModelUsage


MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017"


class PiDurableOptions(InstalledAgentOptions):
    mode: Literal["normal", "async"] = "normal"


class PiDurable(BaseInstalledAgent):
    options_model = PiDurableOptions
    options: PiDurableOptions

    def __init__(self, *args, model_name: str | None = None, **kwargs):
        model_name = model_name or f"sail/{MODEL}"
        if model_name != f"sail/{MODEL}":
            raise ValueError(f"Use sail/{MODEL}")
        super().__init__(*args, model_name=model_name, **kwargs)

    @staticmethod
    def name() -> str:
        return "pi-durable-compaction"

    @property
    def model_connection(self) -> ResolvedModelConnection:
        # Harbor uses this endpoint for tasks with restricted networking.
        return ResolvedModelConnection(provider="sail", inferred_base_url="https://api.sailresearch.com/v1")

    async def install(self, environment: BaseEnvironment) -> None:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent,
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        source = f"https://github.com/Aditya-Mehta1/pi-async-compaction/archive/{revision}.tar.gz"
        await self.ensure_system_dependencies(environment, ("curl", "tar"))
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "mkdir -p /tmp/pi-agent && "
                f"curl -fsSL {shlex.quote(source)} | tar -xz --strip-components=1 -C /tmp/pi-agent && "
                "cd /tmp/pi-agent && npm ci --ignore-scripts && npm run hydrate:model-data"
            ),
        )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        key = self._get_env("SAIL_API_KEY")
        if not key:
            raise ValueError("SAIL_API_KEY is required")
        config_dir = "/tmp/pi-eval-config"
        output_dir = str(self.environment_logs_dir / "pi")
        await self.exec_as_agent(environment, f"mkdir -p {config_dir} {shlex.quote(output_dir)}")
        await self._upload_config_text(
            environment,
            content=json.dumps({"providers": {"sail": {"modelOverrides": {
                model: {"maxTokens": 262144}
                for model in (MODEL, f"{MODEL}-balanced")
            }}}}),
            remote_path=f"{config_dir}/models.json",
            filename="models.json",
        )
        await self._upload_config_text(
            environment,
            content=json.dumps({
                "retry": {"enabled": False, "provider": {"maxRetries": 0}},
                "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 20000},
            }),
            remote_path=f"{config_dir}/settings.json",
            filename="settings.json",
        )
        await self._upload_config_text(
            environment, content=instruction, remote_path="/tmp/pi-eval-instruction.txt", filename="instruction.txt"
        )
        arguments = [
            "node", "--import", "/tmp/pi-agent/packages/coding-agent/src/experimental/source-resolver.ts",
            "/tmp/pi-agent/packages/coding-agent/src/experimental/durable/main.ts",
            "--prompt-file", "/tmp/pi-eval-instruction.txt", "--output-dir", output_dir,
            "--provider", "sail", "--model", MODEL, "--thinking", "high",
            "--background-compaction", self.options.mode, "--background-tokens", "783616",
            "--no-blocking-compaction",
        ]
        await self.exec_as_agent(
            environment,
            command=f'. "$HOME/.nvm/nvm.sh" && {shlex.join(arguments)} > {shlex.quote(output_dir + "/process.log")} 2>&1',
            env={"PI_CODING_AGENT_DIR": config_dir, "SAIL_API_KEY": key},
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        path = self.logs_dir / "pi/events.jsonl"
        if not path.exists():
            return
        records = path.read_text().splitlines()
        for index, line in enumerate(records):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # A killed process may leave its final log record incomplete.
                if index == len(records) - 1:
                    break
                raise
            if event["type"] == "usage":
                context.model_usage = {
                    model: ModelUsage(
                        n_input_tokens=value["input"] + value["cacheRead"] + value["cacheWrite"],
                        n_cache_tokens=value["cacheRead"], n_output_tokens=value["output"],
                        cost_usd=value["cost"]["total"],
                    )
                    for model, value in event["usage"]["models"].items()
                }
            elif event["type"] == "model_metrics":
                context.metadata = {"compaction": event["metrics"]}
        if context.model_usage is not None:
            usage = list(context.model_usage.values())
            context.n_input_tokens = sum(value.n_input_tokens for value in usage)
            context.n_cache_tokens = sum(value.n_cache_tokens for value in usage)
            context.n_output_tokens = sum(value.n_output_tokens for value in usage)
            context.cost_usd = sum(value.cost_usd or 0 for value in usage)
