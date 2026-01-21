function isOutOfTimeRange(initialTime: string, finalTime: string) {
    const utcMinus3Hours = new Date().getUTCHours() - 3;
    const currentHours = (utcMinus3Hours + 24) % 24; // Considerando 24 horas no dia
    const currentMinutes = new Date().getUTCMinutes();

    const [initialHour, initialMinute] = initialTime.split(":").map(Number);
    const [finalHour, finalMinute] = finalTime.split(":").map(Number);

    const isOutsideTimeInterval = (
        (currentHours < initialHour! || (currentHours === initialHour && currentMinutes < initialMinute!)) ||
        (currentHours > finalHour! || (currentHours === finalHour && currentMinutes > finalMinute!))
    );

    if (isOutsideTimeInterval) {
        return true;
    }

    return false;
}

export default isOutOfTimeRange;