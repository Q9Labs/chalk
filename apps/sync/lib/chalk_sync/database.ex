defmodule ChalkSync.Database do
  @moduledoc "Bounded Postgrex connection set for authoritative sync transactions."

  use Supervisor

  alias ChalkSync.Stateholder.SessionKey

  @registry __MODULE__.Registry
  @default_pool_size 8

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(options) do
    Supervisor.start_link(__MODULE__, options, name: __MODULE__)
  end

  @spec connection(SessionKey.t(), non_neg_integer()) :: GenServer.server()
  def connection(%SessionKey{} = session, offset \\ 0) do
    case Application.get_env(:chalk_sync, :database_connections) do
      selector when is_function(selector, 2) ->
        selector.(session, offset)

      connections when is_list(connections) and connections != [] ->
        Enum.at(connections, index(session, length(connections), offset))

      _ ->
        pool_size = Application.get_env(:chalk_sync, :database_pool_size, @default_pool_size)
        via(index(session, pool_size, offset))
    end
  end

  @spec connection_options(String.t()) :: {:ok, keyword()} | {:error, atom()}
  def connection_options(url) when is_binary(url) do
    uri = URI.parse(url)

    with true <- uri.scheme in ["postgres", "postgresql"],
         host when is_binary(host) and host != "" <- uri.host,
         {:ok, username, password} <- credentials(uri.userinfo),
         database when database != "" <- database_name(uri.path),
         {:ok, ssl_options} <- ssl_options(uri) do
      {:ok,
       [
         hostname: host,
         port: uri.port || 5432,
         username: username,
         password: password,
         database: database,
         types: ChalkSync.PostgresTypes
       ] ++ ssl_options}
    else
      _ -> {:error, :invalid_database_url}
    end
  end

  def connection_options(_url), do: {:error, :invalid_database_url}

  @impl Supervisor
  def init(options) do
    url = Keyword.fetch!(options, :url)
    pool_size = Keyword.get(options, :pool_size, @default_pool_size)
    {:ok, connection_options} = connection_options(url)

    children =
      [{Registry, keys: :unique, name: @registry}] ++
        Enum.map(0..(pool_size - 1), fn index ->
          Supervisor.child_spec(
            {Postgrex,
             connection_options ++
               [
                 name: via(index),
                 queue_target: 50,
                 queue_interval: 2_000,
                 timeout: 2_000
               ]},
            id: {:postgrex, index}
          )
        end)

    Supervisor.init(children, strategy: :one_for_one)
  end

  defp index(session, pool_size, offset) do
    rem(:erlang.phash2(SessionKey.authority_key(session), pool_size) + offset, pool_size)
  end

  defp via(index), do: {:via, Registry, {@registry, index}}

  defp credentials(userinfo) when is_binary(userinfo) do
    case String.split(userinfo, ":", parts: 2) do
      [username, password] when username != "" ->
        {:ok, URI.decode(username), URI.decode(password)}

      _ ->
        {:error, :invalid_database_url}
    end
  end

  defp credentials(_userinfo), do: {:error, :invalid_database_url}

  defp database_name(path) when is_binary(path),
    do: path |> String.trim_leading("/") |> URI.decode()

  defp database_name(_path), do: ""

  defp ssl_options(uri) do
    mode = uri.query |> then(&(&1 || "")) |> URI.decode_query() |> Map.get("sslmode")

    case mode do
      "disable" ->
        {:ok, [ssl: false]}

      "require" ->
        {:ok, [ssl: true]}

      "verify-full" ->
        {:ok,
         [
           ssl: true,
           ssl_opts: [verify: :verify_peer, cacerts: :public_key.cacerts_get()]
         ]}

      _ ->
        {:error, :invalid_database_url}
    end
  end
end
