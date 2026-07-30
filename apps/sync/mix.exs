defmodule ChalkSync.MixProject do
  use Mix.Project

  def project do
    [
      app: :chalk_sync,
      version: "0.1.0",
      elixir: "~> 1.19",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps()
    ]
  end

  def application do
    [
      extra_applications: [:crypto, :logger],
      mod: {ChalkSync.Application, []}
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:bandit,
       github: "mtrudel/bandit", ref: "418ef7e906192a230ddba112f7a669c87b6b0e3a", override: true},
      {:postgrex, "~> 0.22.3"},
      {:telemetry, "~> 1.3"},
      {:websock_adapter, "~> 0.5"},
      {:opentelemetry_api, "~> 1.5"},
      {:opentelemetry, "~> 1.7"},
      {:opentelemetry_exporter, "~> 1.10"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:mint_web_socket, "~> 1.0", only: :test},
      {:mint, "~> 1.9.3", only: :test}
    ]
  end
end
