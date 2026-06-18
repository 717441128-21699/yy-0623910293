const { queryOne, queryAll, execRun, getLastInsertId, saveDatabase } = require('../config/database');

class RawMessageModel {
  static create(data) {
    execRun(`
      INSERT INTO raw_messages (content, source_platform, suspected_location)
      VALUES ($content, $source_platform, $suspected_location)
    `, {
      $content: data.content,
      $source_platform: data.source_platform || null,
      $suspected_location: data.suspected_location || null
    });
    saveDatabase();
    return getLastInsertId();
  }

  static countByKeywords(keywords, minutes, exactMatch = false) {
    const timeAgo = new Date(Date.now() - minutes * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    let whereClauses = ['received_at >= $timeAgo'];
    const dbParams = { $timeAgo: timeAgo };

    let keywordConditions = [];
    for (let i = 0; i < keywords.length; i++) {
      const key = `$kw${i}`;
      keywordConditions.push(`content LIKE ${key}`);
      dbParams[key] = `%${keywords[i]}%`;
    }

    if (keywordConditions.length > 0) {
      if (exactMatch) {
        whereClauses.push(`(${keywordConditions.join(' AND ')})`);
      } else {
        whereClauses.push(`(${keywordConditions.join(' OR ')})`);
      }
    }

    const sql = `SELECT COUNT(*) as count FROM raw_messages WHERE ${whereClauses.join(' AND ')}`;
    const result = queryOne(sql, dbParams);
    return result ? result.count : 0;
  }

  static getRecentByKeywords(keywords, minutes, limit = 5, exactMatch = false) {
    const timeAgo = new Date(Date.now() - minutes * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    let whereClauses = ['received_at >= $timeAgo'];
    const dbParams = { $timeAgo: timeAgo, $limit: limit };

    let keywordConditions = [];
    for (let i = 0; i < keywords.length; i++) {
      const key = `$kw${i}`;
      keywordConditions.push(`content LIKE ${key}`);
      dbParams[key] = `%${keywords[i]}%`;
    }

    if (keywordConditions.length > 0) {
      if (exactMatch) {
        whereClauses.push(`(${keywordConditions.join(' AND ')})`);
      } else {
        whereClauses.push(`(${keywordConditions.join(' OR ')})`);
      }
    }

    const sql = `SELECT * FROM raw_messages WHERE ${whereClauses.join(' AND ')} ORDER BY received_at DESC LIMIT $limit`;
    return queryAll(sql, dbParams);
  }

  static cleanupOld(days = 7) {
    const timeAgo = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    execRun('DELETE FROM raw_messages WHERE received_at < $timeAgo', { $timeAgo: timeAgo });
    saveDatabase();
    return true;
  }
}

module.exports = RawMessageModel;
