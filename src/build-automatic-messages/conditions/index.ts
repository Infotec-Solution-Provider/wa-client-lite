import isDateEquals from "./DATE_EQUALS";
import isOutOfTimeRange from "./OUT_TIME_RANGE";

function checkCondition(condition: string): boolean {
    if (condition === "ANY_MESSAGE") {
        return true; 1
    } else if (condition.includes("OUT_TIME_RANGE")) {
        const values = condition.replace("OUT_TIME_RANGE", "").replace("(", "").replace(")", "").replace(" ", "");
        const [initialTime, finalTime] = values.split(",");

        return isOutOfTimeRange(initialTime!, finalTime!);
    } else if (condition.includes("DATE_EQUALS")) {
        const value = condition.replace("DATE_EQUALS", "").replace("(", "").replace(")", "").replace(" ", "");

        return isDateEquals(value);
    }

    return false

}

export default checkCondition;