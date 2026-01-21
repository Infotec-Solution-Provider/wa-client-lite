import { FieldPacket, Pool, RowDataPacket } from "mysql2/promise";
import { logWithDate } from "../utils";
import WhatsappInstance from "../whatsapp";
import { AttendanceWithContact } from "../types";

async function loadAvatars(instance: WhatsappInstance) {
    try {
        const runningAttendances = await getRunningAttendances(instance.pool);

        let successfulUpdates = 0;
        let failedUpdates = 0;
        let deletedNumbers = 0;

        for (let i = 0; i < runningAttendances.length; i++) {
            try {
                const attendance = runningAttendances[i]!;
                logWithDate(`[${i + 1}/${runningAttendances.length}] Carregando avatar: ${attendance.CONTATO_NUMERO}`);

                if (!attendance.CONTATO_NUMERO) {
                    deletedNumbers++;
                    continue;
                }

                const avatar = await instance.getProfilePicture(attendance.CONTATO_NUMERO);

                await updateAttendanceAvatar(instance.pool, attendance.CODIGO, avatar);
                successfulUpdates++;
            } catch {
                failedUpdates++;
            }
        }

        logWithDate(`Success: ${successfulUpdates} | Failed: ${failedUpdates} | Deleted: ${deletedNumbers}`);

        return ({ successfulUpdates, failedUpdates, deletedNumbers });
    } catch (err) {
        logWithDate("Load Avatars Failure =>", err);

        throw new Error("Failed to load avatars...");
    }
}

async function getRunningAttendances(pool: Pool) {
    try {
        const SELECT_QUERY = "SELECT wa.*, ct.NUMERO AS CONTATO_NUMERO FROM w_atendimentos wa LEFT JOIN w_clientes_numeros ct ON ct.CODIGO = wa.CODIGO_NUMERO WHERE wa.CONCLUIDO = 0;";

        const [results]: [RowDataPacket[], FieldPacket[]] = await pool.query(SELECT_QUERY);

        return results as AttendanceWithContact[];
    } catch (err) {
        logWithDate("Get Running Attendances Failure =>", err);

        throw new Error("Failed to load running attendances...");
    }
}

async function updateAttendanceAvatar(pool: Pool, attendanceId: number, avatarUrl: string | null) {
    try {
        const UPDATE_QUERY = "UPDATE w_atendimentos SET AVATAR_URL = ? WHERE CODIGO = ?";

        await pool.query(UPDATE_QUERY, [avatarUrl, attendanceId]);
    } catch (err) {
        logWithDate("Update Avatar Failure =>", err);

        throw new Error("Failed to update avatar...");
    }
}

export default loadAvatars;