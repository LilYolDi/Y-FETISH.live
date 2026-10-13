"use strict";

const crypto = require("node:crypto");

module.exports = function registerDiceRoutes(app, deps) {
  const {
    supabase,
    requireHostAccess,
    cleanText,
    validRoomName,
    getLiveStream,
    guestId,
    sendError
  } = deps;

  // Проверка доступа к комнате ведущего
  async function checkHost(req, res, roomName) {
    if (!validRoomName(roomName)) {
      res.status(400).json({ error: "Неверное имя комнаты" });
      return false;
    }

    const stream = await getLiveStream(roomName);

    if (!stream) {
      res.status(404).json({ error: "Эфир не найден" });
      return false;
    }

    if (stream.host_id !== req.hostId) {
      res.status(403).json({ error: "Это не твой эфир" });
      return false;
    }

    return true;
  }

  async function getGame(roomName) {
    const { data, error } = await supabase
      .from("dice_games")
      .select("*")
      .eq("room_name", roomName)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  // Получить состояние игры
  app.get("/api/dice/state", async (req, res) => {
    try {
      const roomName = cleanText(req.query.roomName, 100);

      if (!validRoomName(roomName)) {
        return res.status(400).json({
          error: "Неверное имя комнаты"
        });
      }

      const game = await getGame(roomName);

      const { data: rounds, error } = await supabase
        .from("dice_rounds")
        .select("*")
        .eq("room_name", roomName)
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) throw error;

      res.json({
        enabled: Boolean(game?.enabled),
        game: game || null,
        rounds: rounds || []
      });
    } catch (error) {
      sendError(res, error, "Не удалось загрузить игру");
    }
  });

  // Таблица корон ведущих
  app.get("/api/dice/leaderboard", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("dice_leaderboard")
        .select("host_id, crowns, updated_at")
        .order("crowns", { ascending: false })
        .limit(50);

      if (error) throw error;

      res.json(data || []);
    } catch (error) {
      sendError(res, error, "Не удалось загрузить рейтинг");
    }
  });

  // Включить игру и выбрать специальный подарок
  app.post(
    "/api/dice/enable",
    requireHostAccess,
    async (req, res) => {
      try {
        const roomName = cleanText(req.body?.roomName, 100);
        const giftId = Number(req.body?.giftId);

        if (!await checkHost(req, res, roomName)) return;

        if (!Number.isSafeInteger(giftId) || giftId <= 0) {
          return res.status(400).json({
            error: "Укажи ID специального подарка"
          });
        }

        const { data: gift, error: giftError } = await supabase
          .from("gifts")
          .select("id, is_dice, active")
          .eq("id", giftId)
          .maybeSingle();

        if (giftError) throw giftError;

        if (!gift || !gift.active || !gift.is_dice) {
          return res.status(400).json({
            error: "Подарок не найден или не отмечен как кубик"
          });
        }

        const { data, error } = await supabase
          .from("dice_games")
          .upsert({
            room_name: roomName,
            host_id: req.hostId,
            enabled: true,
            current_gift_id: giftId,
            round_status: "waiting_gift",
            last_roll: null,
            last_round_id: null,
            current_task: null,
            task_author: null,
            updated_at: new Date().toISOString()
          }, {
            onConflict: "room_name"
          })
          .select()
          .single();

        if (error) throw error;

        res.json({ success: true, game: data });
      } catch (error) {
        sendError(res, error, "Не удалось включить игру");
      }
    }
  );

  // Выключить игру
  app.post(
    "/api/dice/disable",
    requireHostAccess,
    async (req, res) => {
      try {
        const roomName = cleanText(req.body?.roomName, 100);

        if (!await checkHost(req, res, roomName)) return;

        const { error } = await supabase
          .from("dice_games")
          .update({
            enabled: false,
            updated_at: new Date().toISOString()
          })
          .eq("room_name", roomName)
          .eq("host_id", req.hostId);

        if (error) throw error;

        res.json({ success: true });
      } catch (error) {
        sendError(res, error, "Не удалось выключить игру");
      }
    }
  );

  /*
   * Внутренняя функция.
   * Вызывается сервером только после успешной оплаты подарка.
   */
  async function handleDiceGift(roomName, giftId, viewerId) {
    const game = await getGame(roomName);

    if (!game || !game.enabled) return null;
    if (Number(game.current_gift_id) !== Number(giftId)) return null;
    if (game.round_status !== "waiting_gift") return null;

    const { data: gift, error: giftError } = await supabase
      .from("gifts")
      .select("id, is_dice, active")
      .eq("id", giftId)
      .maybeSingle();

    if (giftError) throw giftError;
    if (!gift || !gift.active || !gift.is_dice) return null;

    const stream = await getLiveStream(roomName);

    if (!stream || stream.host_id !== game.host_id) {
      return null;
    }

    const roll = crypto.randomInt(1, 7);
    const roundId = crypto.randomUUID();

    // Сначала фиксируем новый раунд.
    const { data: updated, error: updateError } = await supabase
      .from("dice_games")
      .update({
        round_status: "awaiting_task",
        last_roll: roll,
        last_round_id: roundId,
        current_task: null,
        task_author: viewerId,
        updated_at: new Date().toISOString()
      })
      .eq("room_name", roomName)
      .eq("enabled", true)
      .eq("round_status", "waiting_gift")
      .select("room_name")
      .maybeSingle();

    if (updateError) throw updateError;

    // Если другой запрос уже начал раунд, второй бросок не создаём.
    if (!updated) return null;

    const { error: roundError } = await supabase
      .from("dice_rounds")
      .insert({
        id: roundId,
        room_name: roomName,
        host_id: game.host_id,
        viewer_name: "Гость",
        gift_id: giftId,
        roll,
        status: "awaiting_task"
      });

    if (roundError) {
      await supabase
        .from("dice_games")
        .update({
          round_status: "waiting_gift",
          last_roll: null,
          last_round_id: null,
          updated_at: new Date().toISOString()
        })
        .eq("room_name", roomName)
        .eq("last_round_id", roundId);

      throw roundError;
    }

    return { roundId, roll };
  }

  // Предложить задание после броска
  app.post("/api/dice/task", async (req, res) => {
    try {
      const roomName = cleanText(req.body?.roomName, 100);
      const task = cleanText(req.body?.task, 500);

      if (!validRoomName(roomName) || !task) {
        return res.status(400).json({
          error: "Укажи комнату и задание"
        });
      }

      if (!await getLiveStream(roomName)) {
        return res.status(404).json({ error: "Эфир завершён" });
      }

      const viewerId = guestId(req, res);
      const game = await getGame(roomName);

      if (!game?.enabled || game.round_status !== "awaiting_task") {
        return res.status(409).json({
          error: "Сейчас нельзя отправить задание"
        });
      }

      if (game.task_author && game.task_author !== viewerId) {
        return res.status(403).json({
          error: "Задание может предложить зритель, отправивший подарок"
        });
      }

      const { data, error } = await supabase
        .from("dice_rounds")
        .update({
          task,
          status: "awaiting_host"
        })
        .eq("id", game.last_round_id)
        .eq("room_name", roomName)
        .eq("status", "awaiting_task")
        .select("id")
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(409).json({
          error: "Раунд уже изменился"
        });
      }

      const { error: gameError } = await supabase
        .from("dice_games")
        .update({
          current_task: task,
          round_status: "awaiting_host",
          updated_at: new Date().toISOString()
        })
        .eq("room_name", roomName)
        .eq("last_round_id", game.last_round_id);

      if (gameError) throw gameError;

      res.json({ success: true, task });
    } catch (error) {
      sendError(res, error, "Не удалось отправить задание");
    }
  });

  // Ведущий принимает, отклоняет или завершает задание
  app.post(
    "/api/dice/decision",
    requireHostAccess,
    async (req, res) => {
      try {
        const roomName = cleanText(req.body?.roomName, 100);
        const decision = cleanText(req.body?.decision, 20);

        if (!await checkHost(req, res, roomName)) return;

        if (!["accept", "reject", "complete"].includes(decision)) {
          return res.status(400).json({
            error: "Неизвестное действие"
          });
        }

        const game = await getGame(roomName);

        if (!game || game.host_id !== req.hostId || !game.enabled) {
          return res.status(403).json({
            error: "Игра не активна или нет доступа"
          });
        }

        const allowed = decision === "accept"
          ? ["awaiting_host"]
          : decision === "reject"
            ? ["awaiting_host"]
            : ["accepted"];

        if (!allowed.includes(game.round_status)) {
          return res.status(409).json({
            error: "Сейчас это действие недоступно"
          });
        }

        const roundStatus = {
          accept: "accepted",
          reject: "rejected",
          complete: "completed"
        }[decision];

        const { data: round, error: roundError } = await supabase
          .from("dice_rounds")
          .update({ status: roundStatus })
          .eq("id", game.last_round_id)
          .eq("room_name", roomName)
          .in("status", allowed)
          .select("id")
          .maybeSingle();

        if (roundError) throw roundError;

        if (!round) {
          return res.status(409).json({
            error: "Раунд уже изменился"
          });
        }

        if (decision === "accept") {
          const { error } = await supabase
            .from("dice_games")
            .update({
              round_status: "accepted",
              updated_at: new Date().toISOString()
            })
            .eq("room_name", roomName)
            .eq("last_round_id", game.last_round_id);

          if (error) throw error;

          return res.json({ success: true, status: "accepted" });
        }

        if (decision === "complete") {
          const { data: score, error: scoreError } = await supabase
            .from("dice_leaderboard")
            .select("crowns")
            .eq("host_id", req.hostId)
            .maybeSingle();

          if (scoreError) throw scoreError;

          const { error: crownError } = await supabase
            .from("dice_leaderboard")
            .upsert({
              host_id: req.hostId,
              crowns: Number(score?.crowns || 0) + 1,
              updated_at: new Date().toISOString()
            }, {
              onConflict: "host_id"
            });

          if (crownError) throw crownError;
        }

        // После завершения или отклонения ждём следующий подарок.
        const { error: resetError } = await supabase
          .from("dice_games")
          .update({
            round_status: "waiting_gift",
            last_roll: null,
            last_round_id: null,
            current_task: null,
            task_author: null,
            updated_at: new Date().toISOString()
          })
          .eq("room_name", roomName)
          .eq("host_id", req.hostId);

        if (resetError) throw resetError;

        res.json({
          success: true,
          status: roundStatus,
          crownsAdded: decision === "complete" ? 1 : 0
        });
      } catch (error) {
        sendError(res, error, "Не удалось обработать задание");
      }
    }
  );

  // Функция нужна server.js для связи с уже оплаченным подарком.
  return { handleDiceGift };
};
